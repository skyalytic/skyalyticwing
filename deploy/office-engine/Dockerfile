FROM scratch
ADD ubuntu-root.tar.gz /
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ENV DEBIAN_FRONTEND=noninteractive
COPY packages /wing/packages
RUN printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d && chmod +x /usr/sbin/policy-rc.d \
 && apt-get update && apt-get install -y --no-install-recommends /wing/packages/*.deb fonts-noto-cjk python3 curl ca-certificates \
 && rm -rf /wing/packages /var/lib/apt/lists/* \
 && ! dpkg-query -W code-brand
COPY container-entrypoint.py /wing/entrypoint.py
EXPOSE 9980
ENTRYPOINT ["python3", "/wing/entrypoint.py"]
