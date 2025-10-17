import argparse
import asyncio
import json
import logging
import os
from aiohttp import web
from aiortc import RTCPeerConnection, RTCSessionDescription
from aiortc.contrib.media import MediaPlayer, MediaRelay

pcs = set()
relay = MediaRelay()

VIDEO_FILE = r"E:/EliteSPRINT/elite-sprint-experiments/frontend/truck.mp4"
player = MediaPlayer(VIDEO_FILE)

# Serve index.html directly
INDEX_HTML = """
<!DOCTYPE html>
<html>
<body>
  <h3>WebRTC Video Streaming</h3>
  <video id="video" autoplay playsinline controls width='500' height='300'></video>
  <script>
    async function start() {
      const videoEl = document.getElementById("video");

      // 1️⃣ Request server offer
      const offerResp = await fetch("/offer", { method: "POST" });
      const offer = await offerResp.json();

      // 2️⃣ Create PeerConnection
      const pc = new RTCPeerConnection();
      pc.ontrack = (event) => {
        videoEl.srcObject = event.streams[0];
      };

      // 3️⃣ Set remote description (server offer)
      await pc.setRemoteDescription(offer);

      // 4️⃣ Create answer
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      // 5️⃣ Send answer to server
      await fetch("/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pc.localDescription)
      });
    }

    start();
  </script>
</body>
</html>
"""

async def index(request):
    return web.Response(content_type="text/html", text=INDEX_HTML)

async def offer(request):
    pc = RTCPeerConnection()
    pcs.add(pc)
    print(f"Created PeerConnection {id(pc)}")

    @pc.on("connectionstatechange")
    async def on_connectionstatechange():
        print(f"Connection state: {pc.connectionState}")
        if pc.connectionState == "failed":
            await pc.close()
            pcs.discard(pc)

    # Add video track
    if player.video:
        pc.addTrack(relay.subscribe(player.video))
    else:
        return web.Response(text="No video track in file", status=500)

    # Server creates offer
    offer = await pc.createOffer()
    await pc.setLocalDescription(offer)

    return web.Response(
        content_type="application/json",
        text=json.dumps({
            "sdp": pc.localDescription.sdp,
            "type": pc.localDescription.type
        }),
    )

async def answer(request):
    params = await request.json()
    sdp = RTCSessionDescription(sdp=params["sdp"], type=params["type"])

    # Use the last PeerConnection (for single client)
    if not pcs:
        return web.Response(text="No active PeerConnection", status=400)
    pc = list(pcs)[-1]

    await pc.setRemoteDescription(sdp)
    return web.Response(text="OK")

async def on_shutdown(app):
    coros = [pc.close() for pc in pcs]
    await asyncio.gather(*coros)
    pcs.clear()

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("-v", "--verbose", action="count")
    args = parser.parse_args()

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO)

    app = web.Application()
    app.on_shutdown.append(on_shutdown)
    app.router.add_get("/", index)
    app.router.add_post("/offer", offer)
    app.router.add_post("/answer", answer)

    web.run_app(app, host=args.host, port=args.port)
