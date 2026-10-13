# LED conversation example

User: I want an ESP32 LED project. I have an LED and a 220 ohm resistor, but I have not confirmed the exact board model.

Assistant: Connect GPIO18 to resistor terminal A. Connect resistor terminal B to LED anode. Connect LED cathode to GND.

User: Correction: move GPIO19 to resistor terminal A instead. Keep the other connections unchanged.

Assistant: Here is an illustrative firmware draft. Confirm the board, selected GPIO, LED polarity, and component ratings before using it.

```cpp
const int ledPin = 19;
void setup() {
  pinMode(ledPin, OUTPUT);
}
void loop() {
  digitalWrite(ledPin, HIGH);
  delay(500);
  digitalWrite(ledPin, LOW);
  delay(500);
}
```
