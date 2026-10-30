# Fixed template. Users cannot change it; only the validated package list and settings files vary.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ARG LINXGEN_BUILD_ID
ARG LINXGEN_HOSTNAME
ARG LINXGEN_LOCALE
LABEL org.opencontainers.image.title="LinxGen image" \
      org.opencontainers.image.vendor="LinxGen" \
      io.linxgen.build-id="${LINXGEN_BUILD_ID}" \
      io.linxgen.hostname="${LINXGEN_HOSTNAME}"
COPY context/ /tmp/linxgen/
RUN ["/bin/bash", "/tmp/linxgen/install.sh"]
# Docker processes do not read /etc/default/locale, so the requested locale must be part of the image environment.
ENV LANG=${LINXGEN_LOCALE}
CMD ["/bin/bash"]
