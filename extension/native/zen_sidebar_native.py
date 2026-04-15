#!/usr/bin/env python3
"""
Native messaging host for Zen Sidebar Sync.

Reads Zen Browser's internal session store files to extract workspace
and essential tab data that isn't accessible via WebExtension APIs.

- recovery.jsonlz4: per-tab zenWorkspace UUID and zenEssential boolean
- zen-sessions.jsonlz4: workspace definitions (name, icon, uuid)

Both files use Mozilla's mozLz4 format (8-byte magic + 4-byte size + LZ4 block).
Includes a pure-Python LZ4 block decompressor so no external dependencies are needed.
"""

import sys
import os
import json
import struct
import configparser


# --- LZ4 Block Decompressor ---

def _lz4_block_decompress(src, uncompressed_size):
    """Decompress LZ4 block format (pure Python, no dependencies)."""
    dst = bytearray(uncompressed_size)
    si = 0
    di = 0
    sl = len(src)

    while si < sl:
        token = src[si]
        si += 1

        # Literal length
        lit = (token >> 4) & 0xF
        if lit == 15:
            while si < sl:
                b = src[si]
                si += 1
                lit += b
                if b != 255:
                    break

        # Copy literals
        end = si + lit
        dst[di:di + lit] = src[si:end]
        si = end
        di += lit

        # End of block — last sequence has no match
        if si >= sl:
            break

        # Match offset (2 bytes LE)
        offset = src[si] | (src[si + 1] << 8)
        si += 2

        # Match length (minimum 4)
        ml = (token & 0xF) + 4
        if (token & 0xF) == 15:
            while si < sl:
                b = src[si]
                si += 1
                ml += b
                if b != 255:
                    break

        # Copy match (byte-by-byte for overlapping support)
        mp = di - offset
        for _ in range(ml):
            if di >= uncompressed_size:
                break
            dst[di] = dst[mp]
            di += 1
            mp += 1

    return bytes(dst[:di])


def read_mozlz4(path):
    """Read a Mozilla mozlz4 (jsonlz4) compressed JSON file."""
    with open(path, 'rb') as f:
        data = f.read()

    if data[:8] != b'mozLz40\0':
        raise ValueError('Not a mozlz4 file: invalid magic header')

    uncompressed_size = struct.unpack('<I', data[8:12])[0]

    # Prefer python-lz4 if available (faster), otherwise pure Python
    try:
        import lz4.block
        raw = lz4.block.decompress(data[12:], uncompressed_size=uncompressed_size)
    except ImportError:
        raw = _lz4_block_decompress(data[12:], uncompressed_size)

    return json.loads(raw)


# --- Zen Profile Detection ---

def find_zen_profile():
    """Find the default Zen Browser profile directory."""
    if sys.platform == 'darwin':
        candidates = [
            os.path.expanduser('~/Library/Application Support/zen'),
            os.path.expanduser('~/Library/Application Support/Zen Browser'),
        ]
    elif sys.platform == 'win32':
        appdata = os.environ.get('APPDATA', '')
        candidates = [
            os.path.join(appdata, 'zen'),
            os.path.join(appdata, 'Zen Browser'),
        ]
    else:
        candidates = [
            os.path.expanduser('~/.zen'),
        ]

    for base in candidates:
        ini_path = os.path.join(base, 'profiles.ini')
        if os.path.exists(ini_path):
            profile = _profile_from_ini(base, ini_path)
            if profile:
                return profile

    return None


def _profile_from_ini(base, ini_path):
    """Parse profiles.ini to find the default profile path."""
    cfg = configparser.ConfigParser()
    cfg.read(ini_path)

    # Install* sections have the active default profile
    for sec in cfg.sections():
        if sec.startswith('Install'):
            path = cfg.get(sec, 'Default', fallback=None)
            if path:
                full = os.path.join(base, path) if not os.path.isabs(path) else path
                if os.path.isdir(full):
                    return full

    # Profile sections with Default=1
    for sec in cfg.sections():
        if sec.startswith('Profile'):
            if cfg.get(sec, 'Default', fallback='0') == '1':
                path = cfg.get(sec, 'Path', fallback=None)
                is_rel = cfg.get(sec, 'IsRelative', fallback='1')
                if path:
                    full = os.path.join(base, path) if is_rel == '1' else path
                    if os.path.isdir(full):
                        return full

    # Last resort: first Profile section
    for sec in cfg.sections():
        if sec.startswith('Profile'):
            path = cfg.get(sec, 'Path', fallback=None)
            is_rel = cfg.get(sec, 'IsRelative', fallback='1')
            if path:
                full = os.path.join(base, path) if is_rel == '1' else path
                if os.path.isdir(full):
                    return full

    return None


# --- Session Store Extraction ---

def extract_tab_data(profile):
    """Extract all tabs with workspace/essential data from Zen's session store."""
    result = {'tabs': [], 'workspaces': [], 'groups': [], 'folders': []}

    # 1. Firefox session store: full tab data including zenWorkspace / zenEssential
    recovery = os.path.join(profile, 'sessionstore-backups', 'recovery.jsonlz4')
    if os.path.exists(recovery):
        try:
            session = read_mozlz4(recovery)
            for window in session.get('windows', []):
                for tab in window.get('tabs', []):
                    entries = tab.get('entries', [])
                    if not entries:
                        continue
                    # Session store index is 1-based
                    idx = tab.get('index', len(entries)) - 1
                    idx = max(0, min(idx, len(entries) - 1))
                    entry = entries[idx]
                    url = entry.get('url', '')

                    if not url or not (url.startswith('http://') or url.startswith('https://')):
                        continue

                    result['tabs'].append({
                        'url': url,
                        'title': entry.get('title', ''),
                        'zenWorkspace': tab.get('zenWorkspace'),
                        'zenEssential': bool(tab.get('zenEssential', False)),
                        'pinned': bool(tab.get('pinned', False)),
                        'groupId': tab.get('groupId'),
                    })
        except Exception as e:
            result['_recoveryError'] = str(e)

    # 2. Zen session store: workspaces, groups, folders
    zen_sess = os.path.join(profile, 'zen-sessions.jsonlz4')
    if os.path.exists(zen_sess):
        try:
            zs = read_mozlz4(zen_sess)
            for space in zs.get('spaces', []):
                result['workspaces'].append({
                    'uuid': space.get('uuid', ''),
                    'name': space.get('name', ''),
                    'icon': space.get('icon', ''),
                })
            # Tab groups (Firefox groups + Zen extensions)
            for group in zs.get('groups', []):
                result['groups'].append({
                    'id': group.get('id', ''),
                    'name': group.get('name', ''),
                    'color': group.get('color', ''),
                    'collapsed': bool(group.get('collapsed', False)),
                    'pinned': bool(group.get('pinned', False)),
                    'essential': bool(group.get('essential', False)),
                })
            # Zen folders (pinned-tab containers, can be nested)
            for folder in zs.get('folders', []):
                result['folders'].append({
                    'id': folder.get('id', ''),
                    'name': folder.get('name', ''),
                    'collapsed': bool(folder.get('collapsed', False)),
                    'parentId': folder.get('parentId'),
                    'workspaceId': folder.get('workspaceId', ''),
                    'userIcon': folder.get('userIcon', ''),
                    'isLiveFolder': bool(folder.get('isLiveFolder', False)),
                })
        except Exception as e:
            result['_zenSessionError'] = str(e)

    return result


# --- Native Messaging Protocol ---

def read_message():
    """Read a length-prefixed JSON message from stdin."""
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    length = struct.unpack('=I', raw)[0]
    data = sys.stdin.buffer.read(length)
    return json.loads(data)


def send_message(msg):
    """Write a length-prefixed JSON message to stdout."""
    data = json.dumps(msg, ensure_ascii=False).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('=I', len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


# --- Main ---

def main():
    msg = read_message()
    if not msg:
        return

    try:
        if msg.get('type') == 'get_tab_data':
            profile = find_zen_profile()
            if not profile:
                send_message({'error': 'Zen profile directory not found'})
                return

            data = extract_tab_data(profile)
            send_message({'success': True, 'data': data})
        else:
            send_message({'error': f'Unknown message type: {msg.get("type")}'})
    except Exception as e:
        send_message({'error': str(e)})


if __name__ == '__main__':
    main()
