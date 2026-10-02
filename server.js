const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// public 폴더 안의 HTML, CSS 파일을 정적 파일로 제공
app.use(express.static('public'));

// 클라이언트가 웹소켓으로 접속했을 때
io.on('connection', (socket) => {
    console.log('새로운 사용자가 접속했습니다:', socket.id);

    // 사용자가 메시지를 보냈을 때
    socket.on('chat message', (data) => {
        // 접속해 있는 모든 사람에게 메시지 전송
        io.emit('chat message', data);
    });

    socket.on('disconnect', () => {
        console.log('사용자가 나갔습니다:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`서버가 포트 ${PORT}에서 실행 중입니다.`);
});
