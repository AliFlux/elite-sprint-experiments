import asyncio
from aiortc.contrib.signaling import TcpSocketSignaling

clients = set()

async def handle_client(reader, writer):
    addr = writer.get_extra_info('peername')
    print(f"Client connected: {addr}")
    clients.add(writer)

    try:
        while True:
            # Read message length (4 bytes)
            data = await reader.readexactly(4)
            length = int.from_bytes(data, byteorder="big")
            message = await reader.readexactly(length)

            # Broadcast message to all other clients
            for c in clients:
                if c is not writer:
                    c.write(len(message).to_bytes(4, byteorder="big"))
                    c.write(message)
                    await c.drain()
    except (asyncio.IncompleteReadError, ConnectionResetError):
        print(f"Client disconnected: {addr}")
    finally:
        clients.remove(writer)
        writer.close()
        await writer.wait_closed()


async def main(host="127.0.0.1", port=1234):
    server = await asyncio.start_server(handle_client, host, port)
    print(f"Signaling server running at {host}:{port}")
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("Server stopped")
