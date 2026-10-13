/*
 * Minimal host for the pinned PICSimLab QEMU callback ABI.
 *
 * The callback structure is private to the fork and copied verbatim from
 * hw/xtensa/esp32_picsimlab.c at QEMU_SOURCE_REVISION. Its layout must be
 * reviewed again whenever that revision changes.
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

typedef struct {
  void (*picsimlab_write_pin)(int pin, int value);
  void (*picsimlab_dir_pin)(int pin, int value);
  int (*picsimlab_i2c_event)(const uint8_t id, const uint8_t addr,
                             const uint16_t event);
  uint8_t (*picsimlab_spi_event)(const uint8_t id, const uint16_t event);
  void (*picsimlab_uart_tx_event)(const uint8_t id, const uint8_t value);
  const short int *pinmap;
  void (*picsimlab_rmt_event)(const uint8_t channel, const uint32_t config0,
                              const uint32_t value);
} callbacks_t;

extern void qemu_picsimlab_register_callbacks(void *arg);
extern void qemu_init(int argc, char **argv);
extern int qemu_main_loop(void);
extern void qemu_cleanup(int status);

static FILE *trace_file;
static unsigned int trace_sequence;

/* pinmap slot 20 represents ESP32 GPIO19: slot N maps to GPIO N - 1. */
static const short int pinmap[41] = {
    40, 0,  1,  2,  3,  4,  5,  6,  7,  8,  9,  10, 11, 12,
    13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26,
    27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39};

static void record_gpio_output(int slot, int level) {
  if (slot < 1 || slot > pinmap[0] || pinmap[slot] != 19) {
    return;
  }

  if (fprintf(trace_file,
              "{\"sequence\":%u,\"type\":\"gpio_level\",\"gpio\":19,\"level\":%d}\n",
              ++trace_sequence, level ? 1 : 0) < 0 ||
      fflush(trace_file) != 0) {
    perror("write GPIO trace");
    _Exit(74);
  }
}

static void ignore_direction(int pin, int direction) {
  (void)pin;
  (void)direction;
}

static int ignore_i2c(uint8_t id, uint8_t address, uint16_t event) {
  (void)id;
  (void)address;
  (void)event;
  return 0;
}

static uint8_t ignore_spi(uint8_t id, uint16_t event) {
  (void)id;
  (void)event;
  return 0;
}

static void record_uart(uint8_t id, uint8_t value) {
  if (id == 0 && (fputc(value, stdout) == EOF || fflush(stdout) != 0)) {
    perror("write UART0 transcript");
    _Exit(74);
  }
}

static void ignore_rmt(uint8_t channel, uint32_t config0, uint32_t value) {
  (void)channel;
  (void)config0;
  (void)value;
}

int main(int argc, char **argv) {
  const char *trace_path = getenv("SCHEMORA_GPIO_TRACE");
  if (argc != 2 || trace_path == NULL || trace_path[0] == '\0') {
    fprintf(stderr, "Usage: SCHEMORA_GPIO_TRACE=FILE %s FLASH_IMAGE\n", argv[0]);
    return 64;
  }

  trace_file = fopen(trace_path, "w");
  if (trace_file == NULL) {
    perror("open GPIO trace");
    return 73;
  }

  callbacks_t callbacks = {
      .picsimlab_write_pin = record_gpio_output,
      .picsimlab_dir_pin = ignore_direction,
      .picsimlab_i2c_event = ignore_i2c,
      .picsimlab_spi_event = ignore_spi,
      .picsimlab_uart_tx_event = record_uart,
      .pinmap = pinmap,
      .picsimlab_rmt_event = ignore_rmt,
  };

  /* Registration must precede qemu_init(): the machine wires its GPIO IRQs
   * during board realization and only does so when a host pinmap is present. */
  qemu_picsimlab_register_callbacks(&callbacks);

  char *qemu_argv[] = {
      "qemu-system-xtensa",
      "-M", "esp32-picsimlab",
      "-drive", NULL,
      "-nic", "none",
      "-nographic",
      "-serial", "stdio",
      "-monitor", "none",
      NULL,
  };
  char drive_arg[4096];
  if (snprintf(drive_arg, sizeof(drive_arg), "file=%s,if=mtd,format=raw", argv[1]) >=
      (int)sizeof(drive_arg)) {
    fprintf(stderr, "Flash image path is too long.\n");
    return 64;
  }
  qemu_argv[4] = drive_arg;

  qemu_init((int)(sizeof(qemu_argv) / sizeof(qemu_argv[0]) - 1), qemu_argv);
  int status = qemu_main_loop();
  qemu_cleanup(status);
  if (fclose(trace_file) != 0) {
    perror("close GPIO trace");
    return 74;
  }
  return status;
}
