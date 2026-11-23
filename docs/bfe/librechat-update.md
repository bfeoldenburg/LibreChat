# LibreChat auf mediadev auf den BFE-Fork umstellen

Stand: 16.11.2026. Entwicklungsbranch: `bfe/mcp-groups`.
Die Erweiterung basiert auf dem Fork-`main` bei Commit
`9363db541ecd4e23ab6a41dca47ca48ee2bd418e` vom 15.11.2026 und ergänzt die
geschützte Gruppenabfrage. Die lokale P0-Erweiterung um Gruppennamen und
Gruppenkatalog baut auf `fb9091168c41` auf und benötigt erneut ein eigenes Image. Die Versionsangabe `v0.8.9-rc1` in `package.json`
bezeichnet diesen Quellstand nicht eindeutig; der gleichnamige Release-Tag ist
älter. Der MCP-Dienst und die Datenbankfreigaben folgen anschließend.

Die folgenden Befehle auf `mediadev` mit Schreibzugriff auf `/var` und
Docker-Berechtigung ausführen. Die bestehende Installation liegt unter
`/var/LibreChat`. Quellen, Image-Build und Betriebsinstallation liegen in
diesem Verzeichnis. Die vorhandene Entra-Konfiguration und die Compose-Dateien
werden weiterverwendet.

## 1. Bestehende Konfiguration sichern

```bash
LIBRECHAT_BFE_BACKUP="/var/backups/librechat/$(date +%Y%m%d-%H%M%S)"
install -d -m 700 "$LIBRECHAT_BFE_BACKUP"
cp -p /var/LibreChat/.env /var/LibreChat/librechat.yaml \
  /var/LibreChat/docker-compose.yml /var/LibreChat/docker-compose.override.yml \
  "$LIBRECHAT_BFE_BACKUP/"
docker inspect --format '{{.Image}}' LibreChat \
  > "$LIBRECHAT_BFE_BACKUP/previous-image-id.txt"
printf 'Sicherung: %s\n' "$LIBRECHAT_BFE_BACKUP"
```

`LibreChat` ist der Standard-Containername. Bei einer umbenannten Installation
den tatsächlichen Namen verwenden. Den ausgegebenen Sicherungspfad für einen
späteren Rückwechsel notieren.

## 2. Quellen aktualisieren und eigenes Image bauen

Die Änderungen des Fork-Branches in die bestehende Arbeitskopie unter
`/var/LibreChat` übernehmen. Dieser Weg aktualisiert den aktuellen lokalen
Branch per Fast-Forward und setzt keinen separaten Quellcheckout voraus:

```bash
cd /var/LibreChat &&
git pull --ff-only https://github.com/bfeoldenburg/LibreChat.git bfe/mcp-groups
```

Nach der Quellenaktualisierung kann das nachfolgend beschriebene Rebuild-Skript
verwendet werden. Für einen manuellen Image-Build im selben Verzeichnis:

```bash
cd /var/LibreChat
LIBRECHAT_BFE_COMMIT="$(git rev-parse HEAD)"
LIBRECHAT_BFE_IMAGE="bfe/librechat:$(git rev-parse --short=12 HEAD)"
docker build --pull \
  --build-arg BUILD_COMMIT="$LIBRECHAT_BFE_COMMIT" \
  --build-arg BUILD_BRANCH=bfe/mcp-groups \
  --tag "$LIBRECHAT_BFE_IMAGE" .
printf 'Gebautes Image: %s\n' "$LIBRECHAT_BFE_IMAGE"
```

Das Dockerfile baut die benötigten gemeinsamen Pakete, das Backend und das
Frontend. Auf dem Host ist dafür keine separate Node.js-Installation nötig.
Der Build erfolgt direkt auf dem Dienstserver, daher ist kein Push in eine
Container-Registry erforderlich. Der ausgegebene Image-Tag gehört zu genau
diesem Git-Commit.

## Automatischer Neubau und Wechsel der Image-Kennung

Ergänzung vom 17.11.2026: `rebuild.sh` übernimmt den Neubau aus `/var/LibreChat`
und den Wechsel des Images im Betriebs-Override. Der Betreiber hat die erste
Skriptversion dort aufgerufen; der zuvor voreingestellte separate Quellpfad
war für diese Installation falsch. Die Korrektur verwendet jetzt standardmäßig
das Installationsverzeichnis als Build-Quelle.
Es benötigt Bash, Python 3 und Docker mit Compose-Plugin. Node.js und zusätzliche
Python-Pakete sind auf dem Host nicht erforderlich.

Nach Übertragung beziehungsweise Aktualisierung der Quellen und des korrigierten
Skripts direkt aufrufen:

```bash
/var/LibreChat/rebuild.sh --check
/var/LibreChat/rebuild.sh
```

Quellen und Installation liegen standardmäßig beide unter `/var/LibreChat`.
`--install-dir` legt das gemeinsame Verzeichnis fest; nur bei ausdrücklich
getrennten Quellen zusätzlich `--source-dir` setzen. Das Skript baut den vorhandenen Quellstand;
Quellaktualisierungen wie `git pull --ff-only` erfolgen vorher durch den Betreiber.

Ohne `--image` erhält jeder Build einen neuen Tag nach dem Muster
`bfe/librechat:<Commit>-<UTC-Zeit>`. Lokale Git-Änderungen erscheinen zusätzlich
als `dirty` im Tag. Bei Quellen ohne Git-Metadaten steht dort `local`.
Mit einem eigenen Tag beispielsweise:

```bash
/var/LibreChat/rebuild.sh --image bfe/librechat:mein-build
```

Der Ablauf:

1. Basis und Override zusammen mit `/var/LibreChat/.env` auflösen. Auch der
   vorbereitete neue Override wird mit echtem Compose geprüft. Das Skript erlaubt
   dabei ausschließlich die Änderung von `services.api.image` und
   `services.api.pull_policy`; Ports, Umgebungswerte, Mounts und übrige Dienste
   müssen gleich bleiben. Die aufgelösten ENV-Werte werden nicht ausgegeben.
2. Das Quell-Dockerfile mit sichtbaren Docker-Fortschritts- und Fehlermeldungen
   bauen. Es enthält Backend und Frontend. Git-Commit, Branch und Build-Zeit
   werden über die vorhandenen Dockerfile-Buildargumente mitgegeben.
3. Nach erfolgreichem Build das vorherige Override unter
   `/var/LibreChat/.rebuild-backups/<UTC-Zeit>/docker-compose.override.yml` sichern
   und die Image-Kennung sowie `pull_policy: never` atomar übernehmen. Eine
   während des Builds bemerkte Konfigurationsänderung führt zum Abbruch, bevor
   das Override ersetzt oder ein Container neu erstellt wird.
4. `/var/LibreChat/recreate.sh` ohne Dienstauswahl aufrufen. Dieses vorhandene
   Skript verarbeitet weiterhin `/var/LibreChat/docker-compose.yml` und
   `/var/LibreChat/docker-compose.override.yml` gemeinsam und erstellt den
   gesamten Stack mit den aktiven Profilen neu.

`--check` führt ausschließlich die Konfigurationsprüfung durch. Bei einem
Build- oder Image-Prüffehler bleiben Override und laufende Container unverändert.
Scheitert erst das Recreate, bleiben der neue Override und die ausgegebene
Sicherung erhalten; es erfolgt kein automatischer Rückwechsel möglicherweise
bereits erneuerter Container. Für einen Rückwechsel den gesicherten Override
wiederherstellen und `/var/LibreChat/recreate.sh` ausführen.

Das Override muss für `services` und `services.api` normale eingerückte
YAML-Blöcke verwenden. Nicht unterstützte Inline-Formen werden vor dem Build
abgewiesen. Bestehende Compose-Tags wie `!override` bleiben erhalten.

Lokale Prüfung: `python3 scripts/test_rebuild.py -v`. Die Tests verwenden die
echte Compose-Konfigurationsauflösung mit künstlichen Dateien; Builds,
Image-Inspektion und Recreate werden abgefangen. Es werden keine echten Images
gebaut und keine Container gestartet oder ersetzt.

## 3. Rückrufschlüssel und LibreChat-Konfiguration ergänzen

Mit `openssl rand -hex 32` einen eigenen Rückrufschlüssel erzeugen. In der
vorhandenen `/var/LibreChat/.env` ergänzen:

```dotenv
MCP_AUTHORIZATION_API_KEY=HIER_DEN_NEU_ERZEUGTEN_TOKEN_EINTRAGEN
```

Die vorhandenen Werte einschließlich Entra-Anmeldung weiterverwenden. Der
Schlüssel ist später auch im MCP-Dienst für dessen Rückrufe zu hinterlegen;
er gehört weder in Git noch in normale Benutzerkonfigurationen.

In der vorhandenen `/var/LibreChat/librechat.yaml` auf oberster Ebene ergänzen:

```yaml
mcpAuthorization:
  enabled: true
  apiKeyEnv: MCP_AUTHORIZATION_API_KEY
  groupCatalogPageSize: 100
```

Die vorhandene YAML-Datei samt Versionsangabe und weiteren Einstellungen
beibehalten. Die `librechat.example.yaml` aus dem Fork ist eine Vorlage.

Bei einer Installation mit LibreChat-Mandanten zusätzlich den passenden
`tenantId` im Block setzen. Das ist die **LibreChat-Partition**, nicht
automatisch die Entra-Tenant-ID. Ohne Angabe werden ausschließlich Benutzer
und Gruppen ohne LibreChat-Mandanten gelesen.

## 4. Eigenes Image im vorhandenen Override eintragen

In `/var/LibreChat/docker-compose.override.yml` den bestehenden Service `api`
um folgende Angaben ergänzen. Bei `image` den in Schritt 2 ausgegebenen Tag
einsetzen:

```yaml
services:
  api:
    image: bfe/librechat:HIER_DEN_COMMIT_TAG_AUS_SCHRITT_2_EINTRAGEN
    pull_policy: never
    ports: !override
      - "127.0.0.1:${PORT}:${PORT}"
    environment:
      MCP_AUTHORIZATION_API_KEY: ${MCP_AUTHORIZATION_API_KEY:?MCP_AUTHORIZATION_API_KEY fehlt}
  admin-panel:
    ports: !override
      - "127.0.0.1:3081:3000"
```

Die Portfreigaben entsprechen dem bestehenden Betrieb auf `mediadev`: LibreChat
ist über `127.0.0.1:${PORT}` und die Verwaltung über `127.0.0.1:3081` erreichbar.
`!override` benötigt Docker Compose ab **2.24.4** und ersetzt die Portliste der
Basisdatei vollständig. Ein gewöhnlicher zusätzlicher `ports`-Block würde die
ursprünglichen Freigaben aus der Basisdatei teilweise zusätzlich behalten.

Die Portanpassungen gehören in `/var/LibreChat/docker-compose.override.yml`.
Bei der ersten Bereinigung auch `/var/LibreChat/docker-compose.yml` auf die
unveränderte Basis derselben LibreChat-Version zurückführen. Beide Dateien
zusammen bereitstellen und erst danach den Stack neu erstellen.
Die lokale `docker-compose.override.yml` ist von Git ausgeschlossen und muss
gesondert auf dem Server bereitgestellt werden.

Die vorhandenen Service-Blöcke bearbeiten und ihre weiteren Umgebungsvariablen,
Mounts und Einstellungen erhalten. Keine zweite Definition von `services`,
`api` oder `admin-panel` daneben anlegen. Wenn `environment` bisher als Liste geschrieben
ist, den neuen Eintrag in derselben Form ergänzen:

```yaml
    environment:
      - MCP_AUTHORIZATION_API_KEY=${MCP_AUTHORIZATION_API_KEY:?MCP_AUTHORIZATION_API_KEY fehlt}
```

`pull_policy: never` verwendet das zuvor lokal gebaute Image. Der vorhandene
Mount der `/var/LibreChat/librechat.yaml` muss weiter auf die Konfigurationsdatei
im Container zeigen.

## 5. Den vollständigen Stack neu erstellen

Nach erfolgreichem Image-Build und Übernahme von ENV, YAML und Override:

```bash
/var/LibreChat/recreate.sh
```

Das vorhandene Skript verwendet `/var/LibreChat/.env` und muss beide Dateien
gemeinsam verarbeiten:

- `/var/LibreChat/docker-compose.yml`
- `/var/LibreChat/docker-compose.override.yml`

Der gesamte Stack mit seinen aktiven Profilen wird neu erstellt. Änderungen
an Container-Umgebungsvariablen benötigen diesen Schritt. Für einen späteren
reinen Neustart bestehender Container gibt es `/var/LibreChat/restart.sh`.

## 6. Version, Anmeldung und Gruppenabfrage prüfen

```bash
docker inspect --format '{{.Config.Image}}' LibreChat
docker exec LibreChat node -p 'process.env.BUILD_COMMIT'
```

Image und Commit müssen zu Schritt 2 passen. Anschließend Entra-Anmeldung,
vorhandene Gruppen und einen normalen Chat in LibreChat prüfen.

Für einen Test der Gruppenabfrage eine **lokale LibreChat-Benutzer-ID** aus
der Benutzerverwaltung verwenden. Im folgenden Test die Benutzer-ID ersetzen.
Der Schlüssel wird im Container aus der Umgebung gelesen und nicht ausgegeben:

```bash
docker exec -i LibreChat node --input-type=module - <<'NODE'
const userId = 'HIER_DIE_LOKALE_24_STELLIGE_BENUTZER_ID_EINTRAGEN';
if (!/^[0-9a-f]{24}$/.test(userId)) {
  throw new Error('Zuerst eine gültige lokale LibreChat-Benutzer-ID einsetzen.');
}
const secret = process.env.MCP_AUTHORIZATION_API_KEY;
if (!secret) throw new Error('MCP_AUTHORIZATION_API_KEY fehlt im Container.');
const url = `http://127.0.0.1:${process.env.PORT || '3080'}/api/internal/mcp/groups`;
const response = await fetch(url, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${secret}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ userId }),
});
console.log('HTTP', response.status);
console.log(await response.text());
process.exitCode = response.ok ? 0 : 1;
NODE
```

Erwartet wird `200` mit `userId`, `tenantId`, `groupIds` und `groups`.
`groups` enthält dieselben IDs mit Namen und gespeichertem `updatedAt`. Eine leere
Gruppenliste ist bei einem Benutzer ohne Gruppen gültig. Bei `404` YAML-Aktivierung,
lokale Benutzer-ID und Mandantenpartition prüfen; bei `503` die Schlüsselkonfiguration
und den Datenbankzugriff. Der vollständige Vertrag steht in
[docs/bfe/mcp-authorization.md](mcp-authorization.md).

Den vollständigen Gruppenkatalog ebenfalls intern mit demselben Schlüssel über
`GET /api/internal/mcp/group-catalog` prüfen: alle Seiten bis `nextCursor: null`
lesen, einschließlich einer Gruppe ohne Mitglieder. Die Namensänderung einer
Testgruppe muss bei beiden Routen mit neuerem `updatedAt` erscheinen. Den
Rückruf anschließend aus dem vorgesehenen Dienstnetz testen; ein Aufruf im
LibreChat-Container allein belegt diese Erreichbarkeit nicht. Der öffentliche
Proxy darf die internen Routen nicht freigeben.

## Rückwechsel

ENV, YAML und Override aus der Sicherung aus Schritt 1 wiederherstellen. In
der wiederhergestellten Compose-Konfiguration das vorherige Image verwenden;
dessen genaue ID steht in `previous-image-id.txt` in der Sicherung. Bei Bedarf
diese ID mit `docker image tag` unter einem eigenen Rückwechsel-Tag bereitstellen
und diesen im Override eintragen. Danach wieder den gesamten Stack neu erstellen:

```bash
/var/LibreChat/recreate.sh
```

## Prüfstand dieser Änderung

Die bisherige Mitgliedschaftsabfrage aus `fb9091168c41` läuft laut Betreiber
bereits auf `mediadev`. Gruppenmetadaten und Katalog sind eine anschließende
lokale Erweiterung; deren Bereitstellung ist noch nicht erfolgt.

Der aktuelle lokale Prüfstand einschließlich Typprüfungen, Paket-Builds,
statischer Prüfungen und Lighthouse steht in
[docs/bfe/mcp-authorization.md](mcp-authorization.md).
Offen bleiben der neue Image-Build und Rollout, reale Rückrufe aus dem Dienstnetz,
Entra-/Gruppen-/Chat-Smoke-Tests nach dem Update und die SDK-Kompatibilitätsprüfung
mit dem späteren MCP-Service. Push und Serverupdate übernimmt der Betreiber.
