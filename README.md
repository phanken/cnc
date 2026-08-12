# Bộ đàm nhóm V5 - Low Latency

Bản này giảm delay so với V4 bằng cách:

- Gói micro nhỏ hơn (`ScriptProcessor` 512 thay vì 2048).
- `AudioContext` dùng `latencyHint: "interactive"`.
- Buffer phát ban đầu ~20ms.
- Nếu mạng tạo backlog >220ms thì tự bỏ backlog cũ.
- WebSocket server bật `setNoDelay(true)`.
- Giảm ngưỡng `bufferedAmount` để tránh tích tụ delay.

## Render

Build:
npm install

Start:
npm start

## Lưu ý

Nếu Render đặt server ở khu vực xa Việt Nam, độ trễ mạng vẫn có thể cao.
Muốn kiểu bộ đàm rất sát thời gian thực cho nhiều máy, bước tiếp theo nên dùng
WebRTC + SFU/TURN đặt server gần người dùng.
