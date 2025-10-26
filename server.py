# save as webrtc_klv_fixed.py (replace your original)
import argparse
import asyncio
from fractions import Fraction
import json
import logging
import time
import threading
import random
import os
from aiohttp import web
from aiortc import MediaStreamError, RTCPeerConnection, RTCSessionDescription, MediaStreamTrack
from gi.repository import Gst, GLib
import numpy as np
from PIL import Image
from io import BytesIO

import aiortc.codecs
from aiortc.codecs.h264 import H264Decoder, H264Encoder, h264_depayload
from aiortc.codecs.vpx import Vp8Encoder, Vp8Decoder, VpxPayloadDescriptor, PACKET_MAX
from aiortc.codecs.base import Decoder, Encoder
from aiortc.mediastreams import VIDEO_TIME_BASE, convert_timebase
from aiortc.jitterbuffer import JitterFrame
from aiortc.rtp import RtpPacket
from aiortc.rtcrtpparameters import (
    RTCRtpCodecParameters,
)

from klvdata.misb0601 import UASLocalMetadataSet
import misc  # your helper with parse_klv_local_sets()


Gst.init(None)

# -------------------------------------------------------
# Parameters
# -------------------------------------------------------
VIDEO_TS = r"./raw/videos/truck.ts"
# VIDEO_TS = r"./raw/videos/falls.ts"
VIDEO_TS = r"./raw/videos/truck.ts"
# VIDEO_TS = "./raw/videos/MISB.ts"
# VIDEO_TS = "./raw/videos/DJI_0872.MP4"
# VIDEO_TS = "./raw/videos/falls.ts"
# VIDEO_TS = "./raw/videos/cheyenne.ts"
VIDEO_TS = "./raw/videos/klv_metadata_test_sync.ts"

pcs = set()

# ---------------------------
# RawEncoder for VP8 passthrough (from your code)
# ---------------------------
from av import Packet, VideoFrame

class RawEncoder(Encoder):
    def __init__(self) -> None:
        self.picture_id = random.randint(0, (1 << 15) - 1)

    def encode(
        self, frame: VideoFrame, force_keyframe: bool = False
    ) -> tuple[list[bytes], int]:
        raise NotImplementedError("RawEncoder does not support frame-level encoding.")

    def pack(self, packet: Packet) -> tuple[list[bytes], int]:
        payloads = self._packetize(bytes(packet), self.picture_id)
        timestamp = convert_timebase(packet.pts, packet.time_base, VIDEO_TIME_BASE)
        self.picture_id = (self.picture_id + 1) % (1 << 15)
        return payloads, timestamp

    @classmethod
    def _packetize(cls, buffer: bytes, picture_id: int) -> list[bytes]:
        payloads = []
        descr = VpxPayloadDescriptor(
            partition_start=1, partition_id=0, picture_id=picture_id
        )
        length = len(buffer)
        pos = 0
        while pos < length:
            descr_bytes = bytes(descr)
            size = min(length - pos, PACKET_MAX - len(descr_bytes))
            payloads.append(descr_bytes + buffer[pos : pos + size])
            descr.partition_start = 0
            pos += size
        return payloads

def get_encoder(codec: RTCRtpCodecParameters) -> Encoder:
    mimeType = codec.mimeType.lower()
    if mimeType == "video/vp8":
        return RawEncoder()
    raise ValueError(f"No encoder found for MIME type `{mimeType}`")

aiortc.codecs.get_encoder = get_encoder

# ---------------------------
# GStreamerVideoTrack (reads encoded packets from appsink and returns Packet)
# ---------------------------
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

                # Build packet using real timestamp
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
                    print(f"⚠️ Buffer map failed {self._missed_frames} times in a row. Bad stream!")

        # If no new sample — reuse last good one
        self._missed_frames += 1

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
            return self.appsink.emit("try-pull-sample", Gst.SECOND)
        except Exception as e:
            print(f"⚠️ Error pulling sample: {e}")
            return None

# ---------------------------
# KLV handling: KLVTrack sends parsed KLV metadata to a DataChannel
# ---------------------------
class KLVTrack:
    def __init__(self, sink, data_channel):
        self.sink = sink
        self.dc = data_channel
        # keep an index because you may want to debug which pads map to which stream
        self._enabled = True
        self.loop = asyncio.get_event_loop()

    def start(self):
        # connect the new-sample handler
        try:
            # appsink must have "emit-signals"=True
            self.sink.connect("new-sample", self.on_new_sample)
        except Exception as e:
            print("Failed to connect klv sink new-sample:", e)

    def on_new_sample(self, sink):
        sample = sink.emit("pull-sample")
        if not sample:
            return Gst.FlowReturn.OK

        buffer = sample.get_buffer()
        success, map_info = buffer.map(Gst.MapFlags.READ)
        if not success:
            return Gst.FlowReturn.OK

        raw_bytes = map_info.data

        parsed_sets = misc.parse_klv_local_sets(raw_bytes)
        parsers = UASLocalMetadataSet.parsers

        parsed_metadatas =[]
        for packet in parsed_sets:
            parsed_metadata = {}
            for key, value_bytes in packet.items():
                try:
                    parser = parsers[key]
                    value = parser(value_bytes).value.value
                except Exception:
                    value = value_bytes
                parsed_metadata[int.from_bytes(key, "big")] = value
            parsed_metadatas.append(parsed_metadata)

        self.loop.call_soon_threadsafe(
            self.dc.send, json.dumps(misc.json_safe_serialize(parsed_metadatas))
        )

        buffer.unmap(map_info)
        return Gst.FlowReturn.OK

# ---------------------------
# Build pipeline: programmatic tsdemux handling (fixed)
# ---------------------------
def build_pipeline(input_path):
    is_ts = input_path.lower().endswith(".ts")
    if is_ts:
        # Build elements programmatically to correctly handle dynamic pads.
        pipeline = Gst.Pipeline.new("pipeline")

        filesrc = Gst.ElementFactory.make("filesrc", "source")
        tsdemux = Gst.ElementFactory.make("tsdemux", "demux")
        # Video chain: queue -> decodebin -> videoconvert -> vp8enc -> queue -> appsink
        vqueue = Gst.ElementFactory.make("queue", "vqueue")
        decodebin = Gst.ElementFactory.make("decodebin", "decodebin")
        videoconvert = Gst.ElementFactory.make("videoconvert", "videoconvert")
        vp8enc = Gst.ElementFactory.make("vp8enc", "vp8enc")
        vpostqueue = Gst.ElementFactory.make("queue", "vpostqueue")
        video_sink = Gst.ElementFactory.make("appsink", "video_sink")

        # KLV chain: queue -> appsink
        klv_queue = Gst.ElementFactory.make("queue", "klv_queue")
        klv_sink = Gst.ElementFactory.make("appsink", "klv_sink")

        # basic checks
        elems = [filesrc, tsdemux, vqueue, decodebin, videoconvert, vp8enc, vpostqueue, video_sink, klv_queue, klv_sink]
        if any(e is None for e in elems):
            missing = [name for e,name in zip(elems, ["filesrc","tsdemux","vqueue","decodebin","videoconvert","vp8enc","vpostqueue","video_sink","klv_queue","klv_sink"]) if e is None]
            raise RuntimeError(f"Missing GStreamer elements: {missing} -- check GStreamer installation and plugins")

        # configure elements
        filesrc.set_property("location", input_path)

        # video appsink: pull using try-pull-sample in track
        video_sink.set_property("emit-signals", False)
        video_sink.set_property("sync", False)
        video_sink.set_property("max-buffers", 20)
        video_sink.set_property("drop", True)

        # klv appsink: use signals to call KLVTrack.on_new_sample
        klv_sink.set_property("emit-signals", True)
        klv_sink.set_property("sync", False)
        klv_sink.set_property("max-buffers", 50)
        klv_sink.set_property("drop", True)

        # add to pipeline
        pipeline.add(filesrc)
        pipeline.add(tsdemux)
        pipeline.add(vqueue)
        pipeline.add(decodebin)
        pipeline.add(videoconvert)
        pipeline.add(vp8enc)
        pipeline.add(vpostqueue)
        pipeline.add(video_sink)
        pipeline.add(klv_queue)
        pipeline.add(klv_sink)

        # link what can be statically linked:
        if not filesrc.link(tsdemux):
            raise RuntimeError("Failed to link filesrc -> tsdemux")

        # link decodebin chain statically: we will connect vqueue -> decodebin dynamically
        if not videoconvert.link(vp8enc):
            raise RuntimeError("Failed to link videoconvert -> vp8enc")
        if not vp8enc.link(vpostqueue):
            raise RuntimeError("Failed to link vp8enc -> vpostqueue")
        if not vpostqueue.link(video_sink):
            raise RuntimeError("Failed to link vpostqueue -> video_sink")

        # queue to klv sink will be linked when KLV pad found
        if not klv_queue.link(klv_sink):
            raise RuntimeError("Failed to link klv_queue -> klv_sink")

        # decodebin dynamic pad handler: link decoded video stream into videoconvert chain
        def on_decodebin_pad(decoder, pad):
            caps = pad.get_current_caps()
            if not caps:
                return
            caps_str = caps.to_string()
            # only link video caps
            if caps_str.lower().startswith("video/"):
                sinkpad = videoconvert.get_static_pad("sink")
                if not sinkpad.is_linked():
                    res = pad.link(sinkpad)
                    if res != Gst.PadLinkReturn.OK:
                        print("Failed to link decodebin -> videoconvert:", res)
                    else:
                        print("✅ Linked decodebin video pad -> videoconvert")
            else:
                # ignore non-video pads (audio, etc)
                pass

        decodebin.connect("pad-added", on_decodebin_pad)

        # tsdemux pad-added handler:
        def on_demux_pad(demux, pad):
            caps = pad.get_current_caps()
            caps_str = caps.to_string() if caps else "<unknown>"
            print(f"🔗 demux pad-added: {caps_str}")

            lower = caps_str.lower()
            # If the pad looks like video (mpeg2video/h264/etc) -> link into vqueue -> decodebin
            if lower.startswith("video/") or "video" in lower:
                sinkpad = vqueue.get_static_pad("sink")
                if not sinkpad.is_linked():
                    res = pad.link(sinkpad)
                    if res == Gst.PadLinkReturn.OK:
                        print("✅ Linked demux -> vqueue (video)")
                        # now link queue -> decodebin (queue already in pipeline)
                        if not vqueue.link(decodebin):
                            # sometimes queue->decodebin is not direct linkable; try to link once decodebin has pads (handled above)
                            pass
                    else:
                        print("Failed to link demux video pad:", res)
                return

            # Heuristic for KLV / metadata pads:
            if "klv" in lower or "meta" in lower or "application/octet-stream" in lower or "x-klv" in lower or "meta/x-klv" in lower:
                sinkpad = klv_queue.get_static_pad("sink")
                if not sinkpad.is_linked():
                    res = pad.link(sinkpad)
                    if res == Gst.PadLinkReturn.OK:
                        print("✅ Linked demux -> klv_queue (KLV/metadata)")
                    else:
                        print("Failed to link demux klv pad:", res)
                return

            # else: ignore (audio, teletext, etc)
            print("Skipping demux pad:", caps_str)

        tsdemux.connect("pad-added", on_demux_pad)

        return pipeline, video_sink, klv_sink
    else:
        # fallback single-stream video pipeline (your original path)
        pipeline_str = f"""
            filesrc location="{input_path}" ! \
            decodebin ! \
            videoconvert ! \
            vp8enc cpu-used=4 deadline=1 threads=4 ! \
            queue max-size-buffers=2 max-size-time=0 max-size-bytes=0 ! \
            appsink name=video_sink emit-signals=false max-buffers=20 drop=true sync=true
        """
        pipeline = Gst.parse_launch(pipeline_str)
        video_sink = pipeline.get_by_name("video_sink")
        return pipeline, video_sink, None

# ---------------------------
# Aiohttp handlers
# ---------------------------
klv_index_to_forward = 0  # default (0-based)

async def index(request):
    return web.FileResponse("index.htm")


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
    pipeline, video_sink, klv_sink = build_pipeline(VIDEO_TS)

    track = GStreamerVideoTrack(video_sink)

    # Add the track to the PeerConnection
    pc.addTrack(track)

    # Create a datachannel for klv metadata
    klv_dc = pc.createDataChannel("klv")
    print("Created klv datachannel on server side")

    # KLV handler: start when datachannel opens
    klv_track = None
    if klv_sink:
        klv_track = KLVTrack(klv_sink, klv_dc)

        @klv_dc.on("open")
        def on_open():
            print("KLV DataChannel open. Starting KLVTrack.")
            try:
                klv_track.start()
            except Exception as e:
                print("Failed to start klv_track:", e)

        @klv_dc.on("close")
        def on_close():
            print("KLV DataChannel closed.")

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

# ---------------------------
# Main
# ---------------------------
if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--video", dest="video", default=None,
                        help="path to video file (overrides internal VIDEO_TS)")
    parser.add_argument("--klv-index", dest="klv_index", type=int, default=0,
                        help="Which KLV pad index to forward (0-based). Default 0.")
    parser.add_argument("-v", "--verbose", action="count")
    args = parser.parse_args()

    if args.video:
        VIDEO_TS = args.video

    klv_index_to_forward = args.klv_index

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO)

    app = web.Application()
    app.on_shutdown.append(on_shutdown)
    # app.router.add_get("/", index)
    app.router.add_post("/offer", offer)
    app.router.add_post("/answer", answer)
    static_dir = os.getcwd()
    app.router.add_static("/", static_dir, show_index=True)

    print(f"Starting server on {args.host}:{args.port}, video={VIDEO_TS}, klv_index={klv_index_to_forward}")
    web.run_app(app, host=args.host, port=args.port)
