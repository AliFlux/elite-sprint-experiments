import base64
import datetime
import decimal
import json
import uuid
from enum import Enum
from typing import Any

# try to import numpy (optional). Keep import cost at module-import time.
try:
    import numpy as _np  # type: ignore
except Exception:
    _np = None


_PRIMITIVE_TYPES = (str, int, float, bool, type(None))

def _is_primitive(obj):
    return isinstance(obj, _PRIMITIVE_TYPES)

def json_safe_serialize(obj: Any):
    """
    Recursively convert `obj` into JSON-serializable types.
    - Handles nested dict/list/tuple/set
    - Converts datetime/date/time/timedelta -> ISO / seconds
    - bytes/bytearray -> base64 string
    - uuid.UUID -> str
    - decimal.Decimal -> int/float (or str fallback)
    - Enum -> its value
    - numpy arrays/scalars -> tolist()/item()
    - complex -> [real, imag]
    - objects with __dict__ -> their __dict__ (shallow)
    Returns sanitized object (not a JSON string).
    """

    # fast path for primitives
    if _is_primitive(obj):
        return obj

    # datetimes
    if isinstance(obj, datetime.datetime):
        if obj.tzinfo is None:
            return obj.isoformat() + "Z"
        else:
            # canonicalize to UTC Z
            return obj.astimezone(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
    if isinstance(obj, datetime.date):
        return obj.isoformat()
    if isinstance(obj, datetime.time):
        return obj.isoformat()
    if isinstance(obj, datetime.timedelta):
        return obj.total_seconds()

    # bytes
    if isinstance(obj, (bytes, bytearray)):
        return base64.b64encode(bytes(obj)).decode("ascii")

    # uuid
    if isinstance(obj, uuid.UUID):
        return str(obj)

    # decimal
    if isinstance(obj, decimal.Decimal):
        # try exact int first, otherwise float
        try:
            iv = obj.to_integral_value()
            if obj == iv:
                return int(iv)
        except Exception:
            pass
        try:
            return float(obj)
        except Exception:
            return str(obj)

    # enum
    if isinstance(obj, Enum):
        return json_safe_serialize(obj.value)

    # numpy
    if _np is not None:
        if isinstance(obj, _np.ndarray):
            # fast C-level conversion
            try:
                return obj.tolist()
            except Exception:
                # fallback to manual iterate
                obj = obj.astype(object).tolist()
        if isinstance(obj, _np.generic):
            try:
                return obj.item()
            except Exception:
                try:
                    return float(obj)
                except Exception:
                    return str(obj)

    # complex -> [real, imag]
    if isinstance(obj, complex):
        return [obj.real, obj.imag]

    # mapping-like
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            # JSON object keys must be strings
            if isinstance(k, str):
                key = k
            else:
                key = str(k)
            out[key] = json_safe_serialize(v)
        return out

    # sequences (list/tuple/set)
    if isinstance(obj, (list, tuple, set)):
        return [json_safe_serialize(v) for v in obj]

    # objects with __dict__ (shallow)
    if hasattr(obj, "__dict__"):
        try:
            return json_safe_serialize(vars(obj))
        except Exception:
            pass

    # fallback to str
    try:
        return str(obj)
    except Exception:
        return None
    

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
