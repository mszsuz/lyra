#!/bin/bash
# Сборка Flutter web + запуск HTTP-сервера без кеша
# Использование: bash serve.sh [port]

PORT=${1:-9091}
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Обновить номер сборки
BUILD_NUM=$(date +%Y%m%d-%H%M%S)
cat > lib/core/build_info.dart << EOF
/// Автогенерируемый файл — обновляется при каждой сборке.
/// Не редактировать вручную.
const String buildNumber = '$BUILD_NUM';
EOF
echo "Build: $BUILD_NUM"

# Убить предыдущий сервер на этом порту
PID=$(netstat -ano 2>/dev/null | grep ":$PORT.*LISTENING" | head -1 | awk '{print $5}')
if [ -n "$PID" ] && [ "$PID" != "0" ]; then
  cmd //c "taskkill /PID $PID /T /F" 2>/dev/null
  sleep 1
fi

# Сборка
C:/flutter/bin/flutter build web 2>&1 | tail -3

# HTTP-сервер без кеша
python -c "
import http.server, functools

class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory='build/web', **kwargs)
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

http.server.HTTPServer(('0.0.0.0', $PORT), NoCacheHandler).serve_forever()
" &

sleep 2
echo ""
echo "=== Lyra Mobile web ==="
echo "Local:   http://localhost:$PORT"
echo "Network: http://192.168.1.2:$PORT"
echo "Build:   $BUILD_NUM"
