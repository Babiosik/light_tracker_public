// ESP-12F: кожні 30 секунд надсилає GET-запит на сервер Light Tracker.
// Плата: NodeMCU 1.0 (ESP-12E Module) або Generic ESP8266 Module.
//
// WiFi налаштовується через сторінку, а не в коді:
//  - при першому вмиканні (або якщо збережену мережу не знайдено) ESP роздає WiFi "LightTracker-XXXXXX";
//  - підключіться до нього, сторінка налаштувань відкриється сама (або http://192.168.4.1);
//  - введіть назву мережі та пароль, натисніть "Зберегти", пристрій перезапуститься;
//  - на сторінці показано ID пристрою: його треба додати боту командою /add <id> [назва].
// Повторно відкрити сторінку: утримуйте GPIO0 на GND 3 секунди під час роботи.

#include <ESP8266WiFi.h>
#include <ESP8266WebServer.h>
#include <ESP8266HTTPClient.h>
#include <DNSServer.h>
#include <EEPROM.h>
#include <WiFiClient.h>

// ===== Налаштування =====
const char* SERVER_BASE = "http://localhost/api/light/";  // + ID пристрою
const unsigned long INTERVAL_MS = 30000;               // період запитів, мс (30 сек)
const int HTTP_TIMEOUT_MS = 5000;                      // таймаут запиту, мс
const unsigned long WIFI_CONNECT_TIMEOUT_MS = 60000;   // скільки шукати збережену мережу після старту
const unsigned long WIFI_LOST_LIMIT_MS = 600000;       // скільки WiFi може бути відсутнім під час роботи до відкриття сторінки
const unsigned long PORTAL_IDLE_TIMEOUT_MS = 300000;   // без підключених клієнтів сторінка закривається і пристрій перезапускається
const int CONFIG_BUTTON_PIN = 0;                       // GPIO0 на GND на 3 с відкриває сторінку налаштувань
const unsigned long CONFIG_BUTTON_HOLD_MS = 3000;

// ===== Збереження WiFi у флеш-пам'яті =====
const uint32_t CONFIG_MAGIC = 0x4C545231;  // "LTR1"
struct Config {
  uint32_t magic;
  char ssid[33];
  char pass[65];
};
Config cfg;

WiFiClient wifiClient;
ESP8266WebServer web(80);
DNSServer dns;

unsigned long lastRequestMs = 0;
bool firstRequest = true;
unsigned long wifiLostSince = 0;
unsigned long buttonDownSince = 0;

String deviceId() {
  char buf[16];
  snprintf(buf, sizeof(buf), "esp-%06x", ESP.getChipId());
  return String(buf);
}

bool loadConfig() {
  EEPROM.get(0, cfg);
  if (cfg.magic != CONFIG_MAGIC) return false;
  cfg.ssid[sizeof(cfg.ssid) - 1] = 0;
  cfg.pass[sizeof(cfg.pass) - 1] = 0;
  return cfg.ssid[0] != 0;
}

void saveConfig(const String& ssid, const String& pass) {
  memset(&cfg, 0, sizeof(cfg));
  cfg.magic = CONFIG_MAGIC;
  ssid.toCharArray(cfg.ssid, sizeof(cfg.ssid));
  pass.toCharArray(cfg.pass, sizeof(cfg.pass));
  EEPROM.put(0, cfg);
  EEPROM.commit();
}

String htmlEscape(const String& s) {
  String out;
  for (size_t i = 0; i < s.length(); i++) {
    char c = s[i];
    if (c == '&') out += "&amp;";
    else if (c == '<') out += "&lt;";
    else if (c == '>') out += "&gt;";
    else if (c == '"') out += "&quot;";
    else out += c;
  }
  return out;
}

// ===== Сторінка налаштувань (точка доступу) =====
String networkOptions;     // список знайдених мереж для підказки у формі
unsigned long portalActivityMs = 0;

const char PAGE_HEAD[] PROGMEM =
  "<!DOCTYPE html><html lang=\"uk\"><head><meta charset=\"utf-8\">"
  "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
  "<title>Light Tracker</title><style>"
  "body{font-family:sans-serif;max-width:420px;margin:24px auto;padding:0 16px}"
  "input,button{width:100%;box-sizing:border-box;padding:12px;margin:6px 0 14px;font-size:16px}"
  "button{background:#2b7;color:#fff;border:0;border-radius:6px}"
  ".id{font-size:20px;background:#eee;padding:10px;border-radius:6px;word-break:break-all}"
  "</style></head><body><h2>Light Tracker 💡</h2>";

void handleRoot() {
  portalActivityMs = millis();
  String page = FPSTR(PAGE_HEAD);
  page += "<p>ID пристрою:</p><div class=\"id\"><b>" + deviceId() + "</b></div>";
  page += "<p>Додайте його в Telegram-боті: <code>/add " + deviceId() + " назва</code></p>";
  page += "<form method=\"POST\" action=\"/save\">"
          "<label>Назва WiFi-мережі</label>"
          "<input name=\"ssid\" list=\"nets\" maxlength=\"32\" required autocapitalize=\"none\">"
          "<datalist id=\"nets\">" + networkOptions + "</datalist>"
          "<label>Пароль</label>"
          "<input name=\"pass\" type=\"password\" maxlength=\"64\">"
          "<button type=\"submit\">Зберегти</button></form></body></html>";
  web.send(200, "text/html", page);
}

void handleSave() {
  portalActivityMs = millis();
  String ssid = web.arg("ssid");
  String pass = web.arg("pass");
  if (ssid.length() == 0) {
    web.send(400, "text/plain", "Вкажіть назву мережі");
    return;
  }
  saveConfig(ssid, pass);
  String page = FPSTR(PAGE_HEAD);
  page += "<p>✅ Збережено. Пристрій перезапускається і підключається до <b>" + htmlEscape(ssid) + "</b>.</p>";
  page += "<p>ID пристрою: <b>" + deviceId() + "</b></p></body></html>";
  web.send(200, "text/html", page);
  delay(1500);
  ESP.restart();
}

// Будь-яка інша адреса (перевірка інтернету телефоном тощо) веде на сторінку налаштувань
void handleNotFound() {
  portalActivityMs = millis();
  web.sendHeader("Location", "http://192.168.4.1/", true);
  web.send(302, "text/plain", "");
}

// Не повертається: завершується перезапуском (після збереження або після простою).
void runPortal() {
  Serial.println("Відкриваю сторінку налаштувань...");

  // Скануємо мережі до запуску точки доступу, щоб підказати їх у формі
  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  delay(100);
  int n = WiFi.scanNetworks();
  networkOptions = "";
  for (int i = 0; i < n; i++) {
    networkOptions += "<option value=\"" + htmlEscape(WiFi.SSID(i)) + "\">";
  }

  String apName = "LightTracker-" + deviceId().substring(4);
  WiFi.mode(WIFI_AP);
  WiFi.softAP(apName.c_str());
  delay(200);
  IPAddress ip = WiFi.softAPIP();
  dns.start(53, "*", ip);  // captive portal: усі домени ведуть на пристрій

  web.on("/", handleRoot);
  web.on("/save", HTTP_POST, handleSave);
  web.onNotFound(handleNotFound);
  web.begin();

  Serial.print("WiFi: ");
  Serial.print(apName);
  Serial.print(", сторінка: http://");
  Serial.println(ip);
  Serial.print("ID пристрою: ");
  Serial.println(deviceId());

  portalActivityMs = millis();
  for (;;) {
    dns.processNextRequest();
    web.handleClient();
    if (WiFi.softAPgetStationNum() > 0) portalActivityMs = millis();
    if (millis() - portalActivityMs > PORTAL_IDLE_TIMEOUT_MS) {
      Serial.println("Ніхто не підключився, перезапуск для повторного пошуку мережі");
      ESP.restart();
    }
    delay(2);
  }
}

// ===== Робота з WiFi та сервером =====
bool connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(cfg.ssid, cfg.pass);
  Serial.print("Підключення до ");
  Serial.print(cfg.ssid);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED) {
    if (millis() - start > WIFI_CONNECT_TIMEOUT_MS) {
      Serial.println();
      Serial.println("Мережу не знайдено");
      return false;
    }
    delay(500);
    Serial.print(".");
  }
  Serial.println();
  Serial.print("Підключено, IP: ");
  Serial.println(WiFi.localIP());
  return true;
}

void sendGetRequest() {
  HTTPClient http;
  http.setTimeout(HTTP_TIMEOUT_MS);

  String url = String(SERVER_BASE) + deviceId();
  if (!http.begin(wifiClient, url)) {
    Serial.println("Помилка: http.begin() не вдався");
    return;
  }

  int code = http.GET();
  if (code > 0) {
    Serial.printf("GET %s -> %d: %s\n", url.c_str(), code, http.getString().c_str());
  } else {
    Serial.printf("GET -> помилка: %s\n", http.errorToString(code).c_str());
  }

  http.end();
}

void setup() {
  Serial.begin(115200);
  delay(100);
  Serial.println();
  Serial.print("ID пристрою: ");
  Serial.println(deviceId());

  pinMode(CONFIG_BUTTON_PIN, INPUT_PULLUP);
  EEPROM.begin(sizeof(Config));

  if (!loadConfig() || !connectWiFi()) {
    runPortal();  // мережі немає або її не знайдено: роздаємо свою
  }
}

void loop() {
  // Утримання GPIO0 на GND 3 секунди відкриває сторінку налаштувань
  if (digitalRead(CONFIG_BUTTON_PIN) == LOW) {
    if (buttonDownSince == 0) buttonDownSince = millis();
    if (millis() - buttonDownSince >= CONFIG_BUTTON_HOLD_MS) runPortal();
  } else {
    buttonDownSince = 0;
  }

  if (WiFi.status() != WL_CONNECTED) {
    if (wifiLostSince == 0) {
      wifiLostSince = millis();
      Serial.println("WiFi відключено, очікую перепідключення...");
    }
    if (millis() - wifiLostSince > WIFI_LOST_LIMIT_MS) runPortal();
    delay(500);
    return;
  }
  wifiLostSince = 0;

  unsigned long now = millis();
  // Перший запит одразу після підключення, далі кожні INTERVAL_MS
  if (firstRequest || now - lastRequestMs >= INTERVAL_MS) {
    firstRequest = false;
    lastRequestMs = now;
    sendGetRequest();
  }
}
