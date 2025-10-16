

def parse_klv_local_sets(raw: bytes) -> list[dict[bytes, bytes]]:
    """
    Parse one or more KLV Local Sets (e.g., MISB ST 0601) from a byte stream.
    Returns a list of dicts [{tag_bytes: value_bytes}, ...].
    """
    packets = []
    cursor = 0
    total_len = len(raw)

    while cursor + 18 <= total_len:
        key = raw[cursor:cursor + 16]
        cursor += 16

        if cursor >= total_len:
            break
        length_byte = raw[cursor]
        cursor += 1

        if length_byte & 0x80:
            n = length_byte & 0x7F
            if cursor + n > total_len:
                break
            total_length = int.from_bytes(raw[cursor:cursor + n], "big")
            cursor += n
        else:
            total_length = length_byte

        end = cursor + total_length
        if end > total_len:
            break

        value_bytes = raw[cursor:end]
        cursor = end

        tags = {}
        i = 0
        while i + 2 <= len(value_bytes):
            tag = bytes([value_bytes[i]])  # store key as raw byte
            length = value_bytes[i + 1]
            start = i + 2
            stop = start + length
            if stop > len(value_bytes):
                break
            tags[tag] = value_bytes[start:stop]
            i = stop

        packets.append(tags)

    return packets
