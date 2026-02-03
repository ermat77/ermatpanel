# Mod Configurations

This folder contains example configurations for optional mods.

## SFTP – Add public key (authorized_keys)

The hytale container has `CAP_FOWNER` so chmod works on the volume. Replace `hytale` with your container name if you use a different `STACK_NAME`.

**Append your public key and set permissions:**
```bash
cat sftp-hytale-key.pub | docker exec -i hytale sh -c 'mkdir -p /opt/hytale/server/.ssh && cat >> /opt/hytale/server/.ssh/authorized_keys && chown -R hytale:hytale /opt/hytale/server/.ssh && chmod 700 /opt/hytale/server/.ssh && chmod 600 /opt/hytale/server/.ssh/authorized_keys'
```

**Or copy then append:**
```bash
docker cp sftp-hytale-key.pub hytale:/tmp/key.pub
docker exec hytale sh -c 'mkdir -p /opt/hytale/server/.ssh && cat /tmp/key.pub >> /opt/hytale/server/.ssh/authorized_keys && chown -R hytale:hytale /opt/hytale/server/.ssh && chmod 700 /opt/hytale/server/.ssh && chmod 600 /opt/hytale/server/.ssh/authorized_keys && rm /tmp/key.pub'
```

Then connect: `sftp -P 2222 -i ~/.ssh/your_private_key hytale@your-server`

## EasyWebMap

EasyWebMap is a live web map mod for Hytale servers.

### Installation

1. Download EasyWebMap from [CurseForge](https://www.curseforge.com/hytale/mods/easywebmap)
2. Place the JAR file in `/opt/hytale/mods/`
3. Copy the config:
   ```bash
   mkdir -p /opt/hytale/server/config/cryptobench_EasyWebMap
   cp configs/cryptobench_EasyWebMap/config.json /opt/hytale/server/config/cryptobench_EasyWebMap/
   ```
4. Restart the server

### Access

- Web Map: `http://your-server:18081`
- WebSocket: `ws://your-server:18082`

### API Endpoints

- `GET /api/worlds` - List all worlds
- `GET /api/players/{world}` - Get players in a world
- `GET /api/tiles/{world}/{zoom}/{x}/{y}` - Get map tile
