FROM espressif/idf@sha256:05cbfc42ed2e987b8026722c15bf1d8523d3e4fd1b4ac04d2e4056f5e0918b99

ENV DEBIAN_FRONTEND=noninteractive
ENV QEMU_SOURCE_REVISION=e39508f79cb0681bbe15cfcebd40a3f45cdc3c48
ENV IDF_PATH=/opt/esp/idf

RUN apt-get -o Acquire::ForceIPv4=true -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 update \
    && apt-get install -y --no-install-recommends \
      build-essential \
      git \
      libfdt-dev \
      libgcrypt20-dev \
      libglib2.0-dev \
      libglib2.0-dev-bin \
      libpixman-1-dev \
      libslirp-dev \
      libusb-1.0-0-dev \
      libzstd-dev \
      ninja-build \
      pkg-config \
    && rm -rf /var/lib/apt/lists/*

RUN git init /opt/qemu \
    && git -C /opt/qemu remote add origin https://github.com/lcgamboa/qemu.git \
    && git -C /opt/qemu -c http.version=HTTP/1.1 fetch --depth=1 origin "$QEMU_SOURCE_REVISION" \
    && git -C /opt/qemu checkout --detach FETCH_HEAD

# Build only the Xtensa shared library needed for this pinned original-ESP32 proof.
# The fork's script creates this library by relinking QEMU's Xtensa system target.
RUN ln -s /usr/include/slirp/libslirp.h /usr/include/libslirp.h \
    && ln -s /usr/include/slirp/libslirp-version.h /usr/include/libslirp-version.h \
    && cd /opt/qemu \
    && sed 's/target="xtensa-softmmu,riscv32-softmmu"/target="xtensa-softmmu"/' build_libqemu-esp32.sh > /tmp/build-libqemu-xtensa.sh \
    && chmod +x /tmp/build-libqemu-xtensa.sh \
    && /tmp/build-libqemu-xtensa.sh \
    && nm -D build/libqemu-xtensa.so | grep -q ' qemu_init$' \
    && nm -D build/libqemu-xtensa.so | grep -q ' qemu_main_loop$' \
    && nm -D build/libqemu-xtensa.so | grep -q ' qemu_cleanup$' \
    && nm -D build/libqemu-xtensa.so | grep -q ' qemu_picsimlab_register_callbacks$'

COPY examples/phase6-qemu-gpio-probe/worker.c /opt/probe/worker.c
COPY examples/phase6-qemu-gpio-probe/build-worker.sh /opt/probe/build-worker.sh
COPY examples/phase6-qemu-gpio-probe/prepare-qemu-flash.sh /opt/probe/prepare-qemu-flash.sh
COPY examples/phase6-qemu-gpio-probe/expected-gpio19.jsonl /opt/probe/expected-gpio19.jsonl
COPY examples/phase6-qemu-gpio-probe/filter-event-trace.py /opt/probe/filter-event-trace.py
COPY examples/phase6-qemu-gpio-probe/run-poc.sh /opt/probe/run-poc.sh
COPY examples/phase6-qemu-uart/CMakeLists.txt /opt/fixture/CMakeLists.txt
COPY examples/phase6-qemu-uart/main/ /opt/fixture/main/
COPY examples/phase6-qemu-uart/sdkconfig.defaults /opt/fixture/sdkconfig.defaults
COPY examples/phase6-qemu-gpio-probe/expected-events.jsonl /opt/probe/expected-events.jsonl

RUN bash -lc 'source "$IDF_PATH/export.sh" && idf.py -C /opt/fixture build && bash /opt/probe/prepare-qemu-flash.sh' \
    && bash /opt/probe/build-worker.sh

WORKDIR /opt/qemu
ENTRYPOINT ["bash", "/opt/probe/run-poc.sh"]
