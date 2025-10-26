#!/usr/bin/env python3
import sys
import argparse
from gi import require_version
require_version('Gst', '1.0')
require_version('GObject', '2.0')
from gi.repository import Gst, GLib

Gst.init(None)

from klvdata.misb0601 import UASLocalMetadataSet
import misc  # your helper with parse_klv_local_sets()

class KLVExtractor:
    def __init__(self, filepath):
        self.filepath = filepath
        self.loop = GLib.MainLoop()
        self.pipeline = None
        self.appsink = None

    def build_pipeline(self):
        self.pipeline = Gst.Pipeline.new("klv-pipeline")

        filesrc = Gst.ElementFactory.make("filesrc", "source")
        tsdemux = Gst.ElementFactory.make("tsdemux", "demux")
        queue = Gst.ElementFactory.make("queue", "queue")
        appsink = Gst.ElementFactory.make("appsink", "sink")

        if not all([filesrc, tsdemux, queue, appsink]):
            print("Error: Missing GStreamer elements. Check your GStreamer installation.")
            sys.exit(1)

        filesrc.set_property("location", self.filepath)
        appsink.set_property("emit-signals", True)
        appsink.set_property("sync", False)
        appsink.connect("new-sample", self.on_new_sample)

        self.pipeline.add(filesrc)
        self.pipeline.add(tsdemux)
        self.pipeline.add(queue)
        self.pipeline.add(appsink)

        filesrc.link(tsdemux)
        queue.link(appsink)

        # dynamic pad linking
        tsdemux.connect("pad-added", self.on_pad_added, queue)

        bus = self.pipeline.get_bus()
        bus.add_signal_watch()
        bus.connect("message", self.on_bus_message)
        self.pipeline.use_clock(Gst.SystemClock.obtain())

    def on_pad_added(self, demux, pad, queue):
        caps = pad.get_current_caps()
        caps_str = caps.to_string() if caps else ""
        print(f"New pad: {caps_str}")

        if "x-klv" in caps_str or "meta/x-klv" in caps_str:
            sinkpad = queue.get_static_pad("sink")
            if not sinkpad.is_linked():
                result = pad.link(sinkpad)
                if result == Gst.PadLinkReturn.OK:
                    print("✅ Linked KLV pad to appsink.")
                else:
                    print("❌ Failed to link pad:", result)

    def on_new_sample(self, sink):
        sample = sink.emit("pull-sample")
        buf = sample.get_buffer()
        success, mapinfo = buf.map(Gst.MapFlags.READ)
        if not success:
            return Gst.FlowReturn.OK

        try:
            data = mapinfo.data
            # print(f"[KLV] size={len(data)} bytes")
            # print(" ".join(f"{b:02X}" for b in data[:64]), "..." if len(data) > 64 else "")

            # print(data)
                
            parsed_sets = [misc.parse_klv_local_sets(data)]
            print(parsed_sets)
            # parsers = UASLocalMetadataSet.parsers

            # parsed_metadatas =[]
            # for packet in parsed_sets:
            #     parsed_metadata = {}
            #     for key, value_bytes in packet.items():
            #         try:
            #             parser = parsers[key]
            #             value = parser(value_bytes).value.value
            #         except Exception:
            #             value = value_bytes
            #         parsed_metadata[int.from_bytes(key, "big")] = value
            #     parsed_metadatas.append(parsed_metadata)

            # print(parsed_metadatas)

        finally:
            buf.unmap(mapinfo)

        return Gst.FlowReturn.OK

    def on_bus_message(self, bus, message):
        t = message.type
        if t == Gst.MessageType.EOS:
            print("End of Stream.")
            self.loop.quit()
        elif t == Gst.MessageType.ERROR:
            err, dbg = message.parse_error()
            print("❌ ERROR:", err, dbg)
            self.loop.quit()

    def start(self):
        self.build_pipeline()
        print(f"▶️  Playing {self.filepath}")
        self.pipeline.set_state(Gst.State.PLAYING)
        try:
            self.loop.run()
        except KeyboardInterrupt:
            pass
        finally:
            self.pipeline.set_state(Gst.State.NULL)
            print("Stopped.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Extract raw KLV packets from MPEG-TS file")
    parser.add_argument("file", help="Path to MPEG-TS file (e.g., E:\\xxx\\videos\\cheyenne.ts)")
    args = parser.parse_args()

    extractor = KLVExtractor(args.file)
    extractor.start()
