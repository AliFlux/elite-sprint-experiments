import argparse
import asyncio
from fractions import Fraction
import json
import logging
import time
import threading
from aiohttp import web
from aiortc import MediaStreamError, RTCPeerConnection, RTCSessionDescription, MediaStreamTrack
from gi.repository import Gst, GLib
import numpy as np
from PIL import Image
from io import BytesIO

from aiortc.codecs.h264 import H264Decoder, H264Encoder, h264_depayload
from aiortc.codecs.vpx import Vp8Encoder, Vp8Decoder
from aiortc.jitterbuffer import JitterFrame
from aiortc.rtp import RtpPacket

Gst.init(None)

# -------------------------------------------------------
# Parameters
# -------------------------------------------------------
# VIDEO_TS = r"D:/Downloads/QGISFMV_Samples/MISB/falls.ts"
# VIDEO_TS = r"E:/EliteSPRINT/elite-sprint-experiments/frontend/truck.ts"
VIDEO_TS = r"D:/Downloads/MISB.ts"
VIDEO_TS = r"D:/Downloads/QGISFMV_Samples/DJI/QGIS_Mexico/Videos/DJI_0872.MP4"
pcs = set()

# -------------------------------------------------------
# Video track wrapper around GStreamer appsink
# -------------------------------------------------------
from fractions import Fraction
from aiortc import MediaStreamTrack
from gi.repository import Gst
import asyncio
import numpy as np
from av import Packet, VideoFrame

import asyncio
import numpy as np
from fractions import Fraction
from aiortc import MediaStreamTrack
from av import Packet
import gi

gi.require_version("Gst", "1.0")
from gi.repository import Gst


def debug_pts(buf, time_base):
    # Convert to seconds
    t_sec = buf.pts / Gst.SECOND

    # Convert to ticks before truncation
    raw_ticks = t_sec / time_base

    # Truncated integer pts
    pts_int = int(raw_ticks)

    print(f"GstPTS(ns)={buf.pts:>12} | t={t_sec:>10.6f}s | raw={raw_ticks:>12.3f} | int={pts_int}")

    return pts_int

class GStreamerVideoTrack(MediaStreamTrack):
    kind = "video"

    def __init__(self, appsink):
        super().__init__()
        self.appsink = appsink
        self._pts = 0
        self._time_base = Fraction(1, 30)
        self._missed_frames = 0
        self._decoder = Vp8Decoder()

        # Fallback (red frame)
        img = np.zeros((300, 500, 3), dtype=np.uint8)
        img[:] = (0, 0, 255)
        self._fallback_frame = img.tobytes()
        self._current_frame = self._fallback_frame

        self._printed_caps = False

    async def recv(self):
        """Fetch the next encoded frame from GStreamer (VP8) and wrap it as a Packet."""

        loop = asyncio.get_event_loop()
        sample = await loop.run_in_executor(None, self._pull_sample)

        data = self._current_frame
        valid_frame = False

        if sample is not None:
            buf = sample.get_buffer()
            success, map_info = buf.map(Gst.MapFlags.READ)

            if success:
                try:
                    size = buf.get_size()
                    data = map_info.data[:size]
                    self._current_frame = data
                    self._missed_frames = 0
                    valid_frame = True

                    # Print format once for debugging
                    if not self._printed_caps:
                        caps = sample.get_caps()
                        print("🔹 GStreamer sample caps:", caps.to_string())
                        self._printed_caps = True

                finally:
                    buf.unmap(map_info)

                # ✅ Build packet using real timestamp
                pkt = Packet(data)

                if buf.pts != Gst.CLOCK_TIME_NONE:
                    pkt.pts = int(Fraction(buf.pts, Gst.SECOND) / self._time_base + Fraction(1, 2))
                else:
                    self._pts += 1
                    pkt.pts = self._pts

                pkt.time_base = self._time_base
                return pkt

            else:
                self._missed_frames += 1
                if self._missed_frames % 30 == 0:
                    print(f"⚠️ Buffer map failed {self._missed_frames} times in a row.")

        # If no new sample — reuse last good one
        self._missed_frames += 1
        if self._missed_frames % 30 == 0:
            print(f"⚠️ No new samples for {self._missed_frames} frames.")

        if not valid_frame:
            self._current_frame = bytes()

        pkt = Packet(self._current_frame)
        self._pts += 1
        pkt.pts = self._pts
        pkt.time_base = self._time_base
        return pkt

    def _pull_sample(self):
        """Block until a complete frame is ready."""
        try:
            # ✅ Allow up to 1 second for frame to be ready — frame pacing handled by GStreamer
            return self.appsink.emit("try-pull-sample", Gst.SECOND)
        except Exception as e:
            print(f"⚠️ Error pulling sample: {e}")
            return None
        
# -------------------------------------------------------
# GStreamer pipeline creation
# -------------------------------------------------------
def build_pipeline():
    pipeline_str = f"""
        filesrc location="{VIDEO_TS}" ! \
        decodebin ! \
        videoconvert ! \
        vp8enc cpu-used=4 deadline=1 threads=4 ! \
        queue max-size-buffers=2 max-size-time=0 max-size-bytes=0 !
        appsink name=video_sink emit-signals=false max-buffers=2 drop=false sync=true
    """
    
        # rtpvp8pay2 pt=96 fragmentation-mode=none !

        # filesrc location="{VIDEO_TS}" !
        # decodebin !
        # videoconvert !
        # vp8enc target-bitrate=2000 cpu-used=4 deadline=1 !
        # rtpvp8pay pt=96 !
        # appsink name=video_sink emit-signals=true sync=false max-buffers=20 drop=true

    # pipeline_str = f"""
    #     filesrc location="{VIDEO_TS}" !
    #     x264enc tune=zerolatency bitrate=1000 speed-preset=superfast !
    #     rtph264pay config-interval=1 pt=96 !
    #     appsink name=video_sink emit-signals=true sync=false max-buffers=20 drop=true
    # """

    
        # x264enc tune=zerolatency bitrate=1000 speed-preset=superfast !
        # rtph264pay config-interval=1 pt=96 !
        # appsink name=video_sink emit-signals=true sync=false max-buffers=20 drop=true
    
    pipeline = Gst.parse_launch(pipeline_str)
    video_sink = pipeline.get_by_name("video_sink")
    return pipeline, video_sink

# -------------------------------------------------------
# Serve HTML (client will receive server offer and answer it)
# -------------------------------------------------------
INDEX_HTML = """
<!DOCTYPE html>
<html>
<body>
  <h3>WebRTC Video Streaming</h3>
  <video id="video" autoplay playsinline controls width="1000" height="600"></video>
  <script>
    async function start() {
      const videoEl = document.getElementById("video");

      // 1) Request server offer (server will create the offer)
      const offerResp = await fetch("/offer", { method: "POST" });
      const offer = await offerResp.json();

      // 2) Create PeerConnection on client and set track handler
      const pc = new RTCPeerConnection();
      pc.ontrack = (e) => {
        videoEl.srcObject = e.streams[0];
      };

      // 3) Set remote description (server offer)
      await pc.setRemoteDescription(offer);

      // 4) create answer and setLocalDescription
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      // 5) send answer back to server
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

# -------------------------------------------------------
# Aiohttp handlers
# -------------------------------------------------------
async def index(request):
    return web.Response(content_type="text/html", text=INDEX_HTML)

async def offer(request):
    """
    Server creates an offer and returns it to the client.
    Client will setRemoteDescription(offer) and POST an answer to /answer.
    """
    pc = RTCPeerConnection()
    pcs.add(pc)
    print(f"Created PeerConnection {id(pc)}")

    @pc.on("connectionstatechange")
    async def on_connectionstatechange():
        print(f"Connection state: {pc.connectionState}")
        if pc.connectionState == "failed":
            await pc.close()
            pcs.discard(pc)

    # Build GStreamer pipeline and create our MediaStreamTrack wrapper
    pipeline, video_sink = build_pipeline()
    track = GStreamerVideoTrack(video_sink)

    # Add the track to the PeerConnection
    pc.addTrack(track)

    # Start GStreamer pipeline
    pipeline.set_state(Gst.State.PLAYING)

    # Server creates the offer and sends it to client
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
    """
    Client posts its answer here. Find the corresponding PeerConnection (last one)
    and set its remote description.
    """
    params = await request.json()
    sdp = RTCSessionDescription(sdp=params["sdp"], type=params["type"])
    if not pcs:
        return web.Response(text="No active PeerConnection", status=400)
    # For simple single-client usage take the most recent pc
    pc = list(pcs)[-1]
    await pc.setRemoteDescription(sdp)
    return web.Response(text="OK")

async def on_shutdown(app):
    coros = [pc.close() for pc in pcs]
    await asyncio.gather(*coros)
    pcs.clear()

# -------------------------------------------------------
# Main
# -------------------------------------------------------
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
