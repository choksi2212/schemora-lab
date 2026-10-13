#include <stdio.h>
#include "driver/gpio.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

void app_main(void) {
  esp_err_t setup = gpio_set_direction(GPIO_NUM_19, GPIO_MODE_OUTPUT);
  printf("SCHEMORA_GPIO19_SETUP=%s\n", setup == ESP_OK ? "OK" : "ERROR");
  printf("SCHEMORA_QEMU_REFERENCE_START\n");
  for (unsigned long tick = 0; tick < 5; ++tick) {
    int level = tick % 2 == 0 ? 1 : 0;
    esp_err_t write = gpio_set_level(GPIO_NUM_19, level);
    printf("SCHEMORA_GPIO19_REQUESTED=%d,RESULT=%s,TICK=%lu\n", level,
           write == ESP_OK ? "OK" : "ERROR", tick);
    vTaskDelay(pdMS_TO_TICKS(250));
  }
  printf("SCHEMORA_QEMU_REFERENCE_COMPLETE\n");
  while (1) {
    vTaskDelay(pdMS_TO_TICKS(1000));
  }
}
