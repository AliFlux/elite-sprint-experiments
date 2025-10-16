import gi
import asyncio
import argparse
import json
from aiortc import RTCPeerConnection, MediaStreamTrack, RTCSessionDescription
from aiortc.contrib.signaling import add_signaling_arguments, create_signaling, BYE
from klvdata.misb0601 import UASLocalMetadataSet
import misc  # your helper with parse_klv_local_sets()
from av.packet import Packet

gi.require_version("Gst", "1.0")
from gi.repository import Gst, GLib

Gst.init(None)
TS_PATH = "D:/Downloads/QGISFMV_Samples/MISB/falls.ts"


# -------------------------------------------------------
# KLV Metadata Track (DataChannel)
# -------------------------------------------------------
class KLVTrack:
    def __init__(self, sink, dc):
        self.sink = sink
        self.dc = dc

    def start(self):
        self.sink.connect("new-sample", self.on_new_sample)

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

        for packet in parsed_sets:
            parsed_metadata = {}
            for key, value_bytes in packet.items():
                try:
                    parser = parsers[key]
                    value = parser(value_bytes).value.value
                except Exception:
                    value = value_bytes
                parsed_metadata[int.from_bytes(key, "big")] = value

            if self.dc and self.dc.readyState == "open":
                self.dc.send(json.dumps(parsed_metadata))

        buffer.unmap(map_info)
        return Gst.FlowReturn.OK


# -------------------------------------------------------
# RTP Video Track
# -------------------------------------------------------
class RTPVideoTrack(MediaStreamTrack):
    kind = "video"

    def __init__(self, sink):
        super().__init__()
        self.sink = sink

    async def recv(self):
        sample = await asyncio.get_event_loop().run_in_executor(None, self._pull_sample)
        if not sample:
            await asyncio.sleep(0.01)
            return None

        buf = sample.get_buffer()
        ok, map_info = buf.map(Gst.MapFlags.READ)
        if not ok:
            return None

        packet = Packet(map_info.data)
        buf.unmap(map_info)
        return packet

    def _pull_sample(self):
        return self.sink.emit("pull-sample")


# -------------------------------------------------------
# GStreamer Pad Handling
# -------------------------------------------------------
klv_pad_index = 0


def on_pad_added(demux, pad, pipeline, klv_sink):
    global klv_pad_index
    caps = pad.get_current_caps()
    name = caps.to_string()
    print(f"🔗 New pad discovered: {name}")

    if "meta" in name.lower() or "klv" in name.lower():
        print(f"Found KLV stream #{klv_pad_index + 2}")
        if klv_pad_index == 1:
            print("✅ Linking KLV metadata stream #3")
            queue = Gst.ElementFactory.make("queue", None)
            pipeline.add(queue)
            queue.sync_state_with_parent()
            pad.link(queue.get_static_pad("sink"))
            queue.link(klv_sink)
        klv_pad_index += 1
    else:
        print(f"Skipping non-KLV pad: {name}")


# -------------------------------------------------------
# Build GStreamer Pipeline
# -------------------------------------------------------
def build_pipeline():
    pipeline_str = f"""
        filesrc location="{TS_PATH}" !
        tsdemux name=demux
        demux. ! queue ! decodebin ! x264enc tune=zerolatency bitrate=1000 speed-preset=superfast !
        rtph264pay config-interval=1 pt=96 !
        appsink name=video_sink emit-signals=true max-buffers=20 drop=true sync=false

        demux. ! queue ! appsink name=klv_sink emit-signals=true sync=false
    """
    pipeline = Gst.parse_launch(pipeline_str)
    video_sink = pipeline.get_by_name("video_sink")
    klv_sink = pipeline.get_by_name("klv_sink")
    demux = pipeline.get_by_name("demux")
    demux.connect("pad-added", on_pad_added, pipeline, klv_sink)
    return pipeline, video_sink, klv_sink


# -------------------------------------------------------
# Main WebRTC Loop (Answer-only server)
# -------------------------------------------------------
async def run(pc, signaling):
    pipeline, video_sink, klv_sink = build_pipeline()
    video_track = RTPVideoTrack(video_sink)
    pc.addTrack(video_track)

    # DataChannel for KLV metadata
    dc = pc.createDataChannel("klv-metadata")
    klv_track = KLVTrack(klv_sink, dc)
    klv_track.start()

    await signaling.connect()

    print("Waiting for offer from browser...")
    obj = await signaling.receive()
    if isinstance(obj, RTCSessionDescription):
        await pc.setRemoteDescription(obj)

        # Create answer
        answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        await signaling.send(pc.localDescription)

        print("🎬 Starting GStreamer pipeline...")
        pipeline.set_state(Gst.State.PLAYING)

    # Keep running until BYE or KeyboardInterrupt
    while True:
        obj = await signaling.receive()
        if obj is BYE:
            print("Exiting")
            break


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="GStreamer + KLV WebRTC server")
    add_signaling_arguments(parser)
    args = parser.parse_args()

    pc = RTCPeerConnection()
    signaling = create_signaling(args)

    try:
        asyncio.run(run(pc=pc, signaling=signaling))
    except KeyboardInterrupt:
        pass
    finally:
        asyncio.run(pc.close())
