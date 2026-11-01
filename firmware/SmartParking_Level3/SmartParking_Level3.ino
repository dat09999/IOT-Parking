/**
 * ==============================================================================
 * DU AN: HE THONG QUAN LY BAI DO XE THONG MINH - IOT CAP DO 3 (IoT Level-3)
 * Monitoring Node (ESP32) -> REST API / MQTT -> Cloud Server & SQLite DB -> Web App
 * ==============================================================================
 * So do chan phan cung (GPIO Map):
 * - Cam bien o do P1: GPIO 32 (LM393 IR)
 * - Cam bien o do P2: GPIO 33 (LM393 IR)
 * - Cam bien o do P3: GPIO 34 (LM393 IR)
 * - Cam bien cong vao: GPIO 35 (LM393 IR)
 * - Cam bien cong ra:  GPIO 36 (LM393 IR)
 * - Servo cong vao:    GPIO 25
 * - Servo cong ra:     GPIO 26
 * - Coi Buzzer:        GPIO 27
 * - Man hinh OLED I2C: SDA=GPIO 21, SCL=GPIO 22
 * ==============================================================================
 */

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <ESP32Servo.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

// ================= THONG TIN CAU HINH WIFI VA CLOUD SERVER =================
const char* WIFI_SSID     = "XANHCAFE.COM";     // Thay bang ten WiFi cua ban (hoac WiFi phat tu dien thoai)
const char* WIFI_PASSWORD = "motngayvui";        // Thay bang mat khau WiFi

// Cloud Server URL tren Render (Https công khai toàn cầu)
const char* CLOUD_SERVER_URL = "https://iot-parking.onrender.com/api/parking/data";
const char* IOT_API_KEY      = "IOT_SECURE_TOKEN_2026"; // Khoa bi mat xac thuc thiet bi IoT

// ================= DINH NGHIA PHAN CUNG =================
constexpr uint8_t PIN_P1_SENSOR    = 32;
constexpr uint8_t PIN_P2_SENSOR    = 33;
constexpr uint8_t PIN_P3_SENSOR    = 34;
constexpr uint8_t PIN_ENTRY_SENSOR = 35;
constexpr uint8_t PIN_EXIT_SENSOR  = 36;
constexpr uint8_t PIN_ENTRY_SERVO  = 25;
constexpr uint8_t PIN_EXIT_SERVO   = 26;
constexpr uint8_t PIN_BUZZER       = 27;
constexpr uint8_t PIN_OLED_SDA     = 21;
constexpr uint8_t PIN_OLED_SCL     = 22;

constexpr bool IR_ACTIVE_LOW       = true; // Cam bien IR cho muc LOW khi co vat can

// Goc mo / dong barie
constexpr int ENTRY_CLOSED_ANGLE   = 0;
constexpr int ENTRY_OPEN_ANGLE     = 90;
constexpr int EXIT_CLOSED_ANGLE    = 90;
constexpr int EXIT_OPEN_ANGLE      = 0;

constexpr uint32_t SENSOR_DEBOUNCE_MS   = 350;
constexpr uint32_t GATE_CLOSE_CLEAR_MS  = 1000;
constexpr uint32_t GATE_MAX_OPEN_MS     = 10000;
constexpr uint32_t OLED_REFRESH_MS      = 300;
constexpr uint32_t FULL_BEEP_INTERVAL_MS= 1800;
constexpr uint32_t CLOUD_SYNC_INTERVAL_MS = 1000; // Dong bo voi Cloud moi 1 giay

// [SUA BUZZER] Cau hinh buzzer
constexpr bool     BUZZER_PASSIVE    = false; // false = buzzer CHU DONG (chi can HIGH/LOW). true = buzzer THU DONG (can phat tan so)
constexpr bool     BUZZER_ACTIVE_LOW = true;  // true = module kich muc THAP (LOW = keu, HIGH = im)
constexpr uint16_t BUZZER_FREQ_HZ    = 2000;  // Chi dung khi BUZZER_PASSIVE = true
constexpr uint8_t  BUZZER_LEDC_CH    = 14;    // Chi dung cho ESP32 core 2.x
constexpr uint8_t  BUZZER_IDLE_LEVEL = BUZZER_ACTIVE_LOW ? HIGH : LOW;  // Muc chan khi im lang
constexpr uint8_t  BUZZER_ON_LEVEL   = BUZZER_ACTIVE_LOW ? LOW : HIGH;  // Muc chan khi keu

constexpr uint8_t OLED_WIDTH       = 128;
constexpr uint8_t OLED_HEIGHT      = 64;
constexpr uint8_t OLED_I2C_ADDRESS = 0x3C;

Adafruit_SSD1306 display(OLED_WIDTH, OLED_HEIGHT, &Wire, -1);
Servo entryServo;
Servo exitServo;

enum SensorIndex : uint8_t {
  SENSOR_P1,
  SENSOR_P2,
  SENSOR_P3,
  SENSOR_ENTRY,
  SENSOR_EXIT,
  SENSOR_COUNT
};

const uint8_t SENSOR_PINS[SENSOR_COUNT] = {
  PIN_P1_SENSOR, PIN_P2_SENSOR, PIN_P3_SENSOR,
  PIN_ENTRY_SENSOR, PIN_EXIT_SENSOR
};

struct DebouncedSensor {
  bool rawDetected = false;
  bool stableDetected = false;
  uint32_t rawChangedAt = 0;
};

enum GateState : uint8_t { GATE_CLOSED, GATE_OPEN };

struct GateController {
  GateState state = GATE_CLOSED;
  uint32_t openedAt = 0;
  uint32_t clearSince = 0;
  bool waitingForClear = false;
  bool timeoutReported = false;
};

DebouncedSensor sensors[SENSOR_COUNT];
GateController entryGate;
GateController exitGate;

bool displayReady    = false;
volatile bool buzzerOn = false;
uint32_t lastFullBeepAt = 0;
uint32_t lastDisplayAt  = 0;
uint32_t lastCloudSyncAt= 0;

uint8_t freeSlots   = 3;
bool parkingFull    = false;
bool occupiedP1     = false;
bool occupiedP2     = false;
bool occupiedP3     = false;
bool entryGateOpen  = false;
bool exitGateOpen   = false;

bool lastSyncedP1   = false;
bool lastSyncedP2   = false;
bool lastSyncedP3   = false;
bool lastSyncedEntry= false;
bool lastSyncedExit = false;

// ================= [BUZZER TASK] =================
struct BeepRequest {
  uint16_t freq;
  uint16_t durationMs;
};

QueueHandle_t buzzerQueue = nullptr;

void buzzerSilence() {
  if (BUZZER_PASSIVE) {
#if defined(ESP_ARDUINO_VERSION_MAJOR) && (ESP_ARDUINO_VERSION_MAJOR >= 3)
    ledcDetach(PIN_BUZZER);
#else
    ledcDetachPin(PIN_BUZZER);
#endif
  }
  pinMode(PIN_BUZZER, OUTPUT);
  digitalWrite(PIN_BUZZER, BUZZER_IDLE_LEVEL);
}

void buzzerSoundOn(uint16_t freq) {
  if (BUZZER_PASSIVE) {
#if defined(ESP_ARDUINO_VERSION_MAJOR) && (ESP_ARDUINO_VERSION_MAJOR >= 3)
    ledcAttach(PIN_BUZZER, freq, 8);
    ledcWriteTone(PIN_BUZZER, freq);
#else
    ledcSetup(BUZZER_LEDC_CH, freq, 8);
    ledcAttachPin(PIN_BUZZER, BUZZER_LEDC_CH);
    ledcWriteTone(BUZZER_LEDC_CH, freq);
#endif
  } else {
    digitalWrite(PIN_BUZZER, BUZZER_ON_LEVEL);
  }
}

void buzzerTask(void *param) {
  BeepRequest req;
  for (;;) {
    if (xQueueReceive(buzzerQueue, &req, portMAX_DELAY) == pdTRUE) {
      buzzerOn = true;
      buzzerSoundOn(req.freq);
      vTaskDelay(pdMS_TO_TICKS(req.durationMs));
      buzzerSilence();
      buzzerOn = false;
      vTaskDelay(pdMS_TO_TICKS(30));
    }
  }
}

void initBuzzer() {
  buzzerSilence();
  buzzerQueue = xQueueCreate(2, sizeof(BeepRequest));
  xTaskCreatePinnedToCore(buzzerTask, "buzzerTask", 2048, nullptr, 1, nullptr, 0);
}

void startBeep(uint16_t durationMs) {
  if (buzzerQueue == nullptr) return;
  BeepRequest req = { BUZZER_FREQ_HZ, durationMs };
  xQueueSend(buzzerQueue, &req, 0);
}

// ================= CAC HAM XU LY PHAN CUNG =================
bool readDetected(uint8_t pin) {
  const int level = digitalRead(pin);
  return IR_ACTIVE_LOW ? (level == LOW) : (level == HIGH);
}

void updateSensor(DebouncedSensor &sensor, uint8_t pin, uint32_t now) {
  const bool reading = readDetected(pin);
  if (reading != sensor.rawDetected) {
    sensor.rawDetected = reading;
    sensor.rawChangedAt = now;
  }
  if (sensor.stableDetected != sensor.rawDetected &&
      now - sensor.rawChangedAt >= SENSOR_DEBOUNCE_MS) {
    sensor.stableDetected = sensor.rawDetected;
  }
}

void setEntryGate(bool open, uint32_t now) {
  if (open) {
    entryServo.write(ENTRY_OPEN_ANGLE);
    entryGate.state = GATE_OPEN;
    entryGate.openedAt = now;
    entryGate.waitingForClear = false;
    entryGate.timeoutReported = false;
  } else {
    entryServo.write(ENTRY_CLOSED_ANGLE);
    entryGate.state = GATE_CLOSED;
    entryGate.waitingForClear = false;
  }
  entryGateOpen = open;
}

void setExitGate(bool open, uint32_t now) {
  if (open) {
    exitServo.write(EXIT_OPEN_ANGLE);
    exitGate.state = GATE_OPEN;
    exitGate.openedAt = now;
    exitGate.waitingForClear = false;
    exitGate.timeoutReported = false;
  } else {
    exitServo.write(EXIT_CLOSED_ANGLE);
    exitGate.state = GATE_CLOSED;
    exitGate.waitingForClear = false;
  }
  exitGateOpen = open;
}

void updateParkingStatus() {
  occupiedP1 = sensors[SENSOR_P1].stableDetected;
  occupiedP2 = sensors[SENSOR_P2].stableDetected;
  occupiedP3 = sensors[SENSOR_P3].stableDetected;
  const uint8_t occupiedCount = static_cast<uint8_t>(occupiedP1) +
                                static_cast<uint8_t>(occupiedP2) +
                                static_cast<uint8_t>(occupiedP3);
  freeSlots = 3 - occupiedCount;
  parkingFull = (freeSlots == 0);
}

/**
 * ==============================================================================
 * LOGIC QUY TRINH 7 BUOC:
 * - CONG VAO (isEntry = true): TUYET DOI KHONG TU DONG MO khi thay xe!
 *   Cac buoc: Xe den -> Cam bien GPIO 35 phat hien -> ESP32 gui bao xe len Web ->
 *   Cho Camera quet bien so -> Web so CSDL hop le -> Web gui lenh "OPEN_ENTRY" -> ESP32 moi mo cong!
 * - CONG RA (isEntry = false): Tu dong mo khi xe ra den vach cam bien GPIO 36.
 * ==============================================================================
 */
void updateGate(GateController &gate, bool vehicleAtGate, bool isEntry, uint32_t now) {
  if (gate.state == GATE_CLOSED) {
    if (vehicleAtGate) {
      if (isEntry) {
        // [QUY TRINH 7 BUOC] CONG VAO: GIU NGUYEN TRANG THAI DONG!
        // Chi keu tieng bip ngan thong bao da nhan dien co xe den vung cho quet bien so
        static uint32_t lastEntryPromptBeep = 0;
        if (now - lastEntryPromptBeep >= 3000) {
          lastEntryPromptBeep = now;
          if (parkingFull) {
            startBeep(350); // Bai day keu dai canh bao
          } else {
            startBeep(60);  // Bip ngan: "Xe da vao vung quet bien so"
          }
        }
      } else {
        // CONG RA: Tu dong nang barie cho xe ra
        setExitGate(true, now);
        startBeep(90);
      }
    }
    return;
  }

  // Khi cong dang MO: Cho xe di qua het khoi vung cam bien roi dong lai an toan
  if (vehicleAtGate) {
    gate.waitingForClear = false;
    if (now - gate.openedAt >= GATE_MAX_OPEN_MS && !gate.timeoutReported) {
      gate.timeoutReported = true;
      Serial.println(isEntry ? "Entry gate timeout: sensor occupied" : "Exit gate timeout: sensor occupied");
      startBeep(500);
    }
  } else {
    if (!gate.waitingForClear) {
      gate.waitingForClear = true;
      gate.clearSince = now;
    } else if (now - gate.clearSince >= GATE_CLOSE_CLEAR_MS) {
      if (isEntry) setEntryGate(false, now);
      else setExitGate(false, now);
      return;
    }
  }
}

void updateDisplay(uint32_t now) {
  if (!displayReady || now - lastDisplayAt < OLED_REFRESH_MS) return;
  lastDisplayAt = now;
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.print(F("IoT Level-3 "));
  display.println(WiFi.status() == WL_CONNECTED ? F("[WIFI ON]") : F("[NO WIFI]"));
  display.print(F("Con trong: "));
  display.println(freeSlots);
  display.print(F("P1:")); display.print(occupiedP1 ? F("XE ") : F("TRG "));
  display.print(F("P2:")); display.print(occupiedP2 ? F("XE ") : F("TRG "));
  display.print(F("P3:")); display.println(occupiedP3 ? F("XE") : F("TRG"));
  display.print(F("Vao:")); display.print(entryGateOpen ? F("MO ") : F("CHO "));
  display.print(F("Ra:")); display.println(exitGateOpen ? F("MO") : F("DONG"));
  if (parkingFull) display.println(F(">>> BAI XE DAY <<<"));
  display.display();
}

// ================= GIAO TIEP DAM MAY IOT CAP DO 3 (REST API) =================
void sendTelemetryToCloud() {
  if (WiFi.status() != WL_CONNECTED) {
    return;
  }

  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;
  http.begin(client, CLOUD_SERVER_URL);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-API-Key", IOT_API_KEY);

  // Dong goi JSON Telemetry kem trang thai xe dang o cong vao
  String payload = "{";
  payload += "\"p1\":" + String(occupiedP1 ? 1 : 0) + ",";
  payload += "\"p2\":" + String(occupiedP2 ? 1 : 0) + ",";
  payload += "\"p3\":" + String(occupiedP3 ? 1 : 0) + ",";
  payload += "\"entryGate\":" + String(entryGateOpen ? 1 : 0) + ",";
  payload += "\"exitGate\":" + String(exitGateOpen ? 1 : 0) + ",";
  payload += "\"vehicleAtEntry\":" + String(sensors[SENSOR_ENTRY].stableDetected ? 1 : 0) + ",";
  payload += "\"vehicleAtExit\":" + String(sensors[SENSOR_EXIT].stableDetected ? 1 : 0) + ",";
  payload += "\"free\":" + String(freeSlots);
  payload += "}";

  int httpCode = http.POST(payload);
  if (httpCode >= 200 && httpCode < 300) {
    String response = http.getString();
    response.replace(" ", "");
    response.replace("\n", "");
    response.replace("\r", "");
    response.replace("\t", "");

    if (response.indexOf("command") >= 0) {
      Serial.print(F("[Cloud] Response: "));
      Serial.println(response);
    }

    // CHI MO CONG VAO KHI NHAN LENH CHINH THUC "OPEN_ENTRY" TU WEBSITE (DA SO KHOP BIEN SO HOP LE)
    if (response.indexOf("OPEN_ENTRY") >= 0) {
      Serial.println("[Cloud Action] Nhan lenh mo cong vao tu Web (Bien so hop le)!");
      setEntryGate(true, millis());
      startBeep(120);
    }
    if (response.indexOf("OPEN_EXIT") >= 0) {
      Serial.println("[Cloud Action] Nhan lenh mo cong ra tu Web!");
      setExitGate(true, millis());
      startBeep(120);
    }
    if (response.indexOf("TRIGGER_BUZZER") >= 0) {
      Serial.println("[Cloud Action] Nhan lenh bat coi tu Web!");
      startBeep(800);
    }
  }
  http.end();

  lastSyncedP1    = occupiedP1;
  lastSyncedP2    = occupiedP2;
  lastSyncedP3    = occupiedP3;
  lastSyncedEntry = entryGateOpen;
  lastSyncedExit  = exitGateOpen;
}

// ================= SETUP =================
void setup() {
  pinMode(PIN_BUZZER, OUTPUT);
  digitalWrite(PIN_BUZZER, BUZZER_IDLE_LEVEL);

  Serial.begin(115200);
  Serial.println(F("\n--- KHOI DONG HE THONG IOT CAP DO 3: SMART PARKING ---"));

  for (uint8_t i = 0; i < SENSOR_COUNT; ++i) {
    pinMode(SENSOR_PINS[i], INPUT);
    sensors[i].rawDetected = readDetected(SENSOR_PINS[i]);
    sensors[i].stableDetected = sensors[i].rawDetected;
    sensors[i].rawChangedAt = millis();
  }

  Wire.begin(PIN_OLED_SDA, PIN_OLED_SCL);
  displayReady = display.begin(SSD1306_SWITCHCAPVCC, OLED_I2C_ADDRESS);

  entryServo.attach(PIN_ENTRY_SERVO, 500, 2400);
  exitServo.attach(PIN_EXIT_SERVO, 500, 2400);
  entryServo.write(ENTRY_CLOSED_ANGLE);
  exitServo.write(EXIT_CLOSED_ANGLE);
  entryGateOpen = false;
  exitGateOpen = false;

  initBuzzer();
  updateParkingStatus();

  Serial.printf("Dang ket noi WiFi toi '%s'...\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  if (displayReady) {
    display.clearDisplay();
    display.setTextColor(SSD1306_WHITE);
    display.setTextSize(1);
    display.setCursor(0, 0);
    display.println(F("IoT Level-3 Parking"));
    display.println(F("Ket noi WiFi..."));
    display.display();
  }
}

// ================= LOOP =================
void loop() {
  const uint32_t now = millis();

  for (uint8_t i = 0; i < SENSOR_COUNT; ++i) {
    updateSensor(sensors[i], SENSOR_PINS[i], now);
  }

  updateParkingStatus();

  // Logic dieu khien barie:
  // Cong vao tuyet doi khong tu mo, cho lenh Web
  updateGate(entryGate, sensors[SENSOR_ENTRY].stableDetected, true, now);
  updateGate(exitGate, sensors[SENSOR_EXIT].stableDetected, false, now);

  updateDisplay(now);

  const bool stateChanged = (occupiedP1 != lastSyncedP1) ||
                            (occupiedP2 != lastSyncedP2) ||
                            (occupiedP3 != lastSyncedP3) ||
                            (entryGateOpen != lastSyncedEntry) ||
                            (exitGateOpen != lastSyncedExit) ||
                            (sensors[SENSOR_ENTRY].stableDetected);

  if (stateChanged || (now - lastCloudSyncAt >= CLOUD_SYNC_INTERVAL_MS)) {
    lastCloudSyncAt = now;
    sendTelemetryToCloud();
  }
}
