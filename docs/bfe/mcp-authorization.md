# Gruppenabfragen für den Wissensdatenbank-MCP-Dienst

Stand: 16.11.2026. Branch: `bfe/mcp-groups`. Basis ist der Fork-`main` bei
Commit `9363db541ecd4e23ab6a41dca47ca48ee2bd418e` vom 15.11.2026.
Die Erweiterung um Gruppenmetadaten und Katalog baut auf
`fb9091168c41de73777d7a07f825b754e39959b5` auf.

LibreChat verwaltet Benutzer und Gruppen. Der spätere MCP-Dienst verwaltet die
Zuordnung von **LibreChat-Gruppen-IDs zu Wissensdatenbanken** und prüft sie vor
jedem Datenzugriff. Die Freigabe gilt jeweils für die ganze Wissensdatenbank.

Diese Erweiterung stellt die interne Mitgliedschaftsabfrage und einen
vollständigen Gruppenkatalog für vertrauenswürdige Dienste bereit.
Sie erstellt keine Gruppen, verändert keine Mitgliedschaften und vergibt selbst
keine Datenbankrechte. Die MCP-seitige Durchsetzung und deren Integrationstests
gehören zum anschließenden Aufbau des MCP-Dienstes.

## Vertrauensgrenze

Es werden zwei getrennte Dienstschlüssel benötigt:

1. **LibreChat → MCP:** Der MCP-Dienst authentifiziert LibreChat als seinen
   vertrauenswürdigen Aufrufer. LibreChat setzt die lokale Benutzer-ID aus dem
   angemeldeten Benutzer, beispielsweise mit `{{LIBRECHAT_USER_ID}}` in einer
   vom Betreiber gepflegten MCP-Konfiguration. Der MCP-Dienst darf eine
   Benutzer-ID erst nach dieser Dienstauthentifizierung verwenden. Benutzer-ID,
   Gruppen und Datenbankrechte dürfen nicht aus Modellargumenten stammen.
2. **MCP → LibreChat:** Ein eigener Rückrufschlüssel authentifiziert den
   MCP-Dienst an beiden internen Gruppenrouten. Dieser Schlüssel erlaubt das Lesen
   der Gruppenmitgliedschaften und des Gruppenkatalogs der konfigurierten Partition.
   Er authentifiziert den Dienst und ist kein persönliches Benutzertoken.

Beide Schlüssel bleiben ausschließlich in den Serverumgebungen. Der erste
Schlüssel gehört nicht in die Hände normaler LibreChat-Benutzer. Ein Besitzer
dieses Schlüssels kann als vertrauenswürdiger Gateway Benutzer-IDs auswählen.
Die Vorlage ist deshalb für eine vom Betreiber eingerichtete interne Verbindung
gedacht. Ein freier Zugriff auf den MCP-Dienst mit einer Benutzer-ID allein
muss abgewiesen werden. Dienstverbindungen über Netzwerkgrenzen mit TLS
absichern und den Rückrufpfad auf die beteiligten Dienste begrenzen.

Entra übernimmt weiterhin die Anmeldung. Die Gruppenabfrage liest die in
LibreChat gespeicherten Mitgliedschaften; sie setzt keine Gruppen aus einem
Entra-Token voraus. Der bestehende Entra-Login wird nicht verändert.

## Konfiguration

Ohne Konfiguration bleiben beide Routen deaktiviert. Nur die vom Betreiber
bereitgestellte `librechat.yaml` darf diese Vertrauensgrenze konfigurieren;
gespeicherte Basis-, Rollen-, Gruppen- oder Benutzerprofile können sie nicht
ändern.

```yaml
mcpAuthorization:
  enabled: true
  apiKeyEnv: MCP_AUTHORIZATION_API_KEY
  groupCatalogPageSize: 100
  # Nur bei einer Installation mit LibreChat-Mandanten setzen:
  # tenantId: bfe
```

In der **Prozessumgebung des LibreChat-Backends** wird der Rückrufschlüssel als
`MCP_AUTHORIZATION_API_KEY` gesetzt. Einen eigenen Wert beispielsweise mit
`openssl rand -hex 32` erzeugen und sicher auf LibreChat und dem MCP-Dienst
bereitstellen. Die Route verlangt 32 bis 512 Zeichen ohne äußere Leerzeichen.
Der tatsächliche Wert steht nicht in YAML, Konfigurationsantworten oder Logs.

`tenantId` bezeichnet eine LibreChat-Partition, nicht die Entra-Tenant-ID.
Ohne diese Angabe werden ausschließlich Benutzer und Gruppen ohne
LibreChat-Mandanten gelesen. Bei aktivierter strikter Mandantentrennung ist
eine passende Partition erforderlich; eine unzulässige Abfrage scheitert.
Body, Query-Parameter und eingehende Mandanten-Header können diese Zuordnung
nicht überschreiben. `groupCatalogPageSize` ist die Standardseitengröße und die
Obergrenze für angeforderte Katalogseiten: ganze Zahl von 1 bis 500, Standard 100.
Diese Betreiberoption kann ebenso wie die Aktivierung nur in der Basisdatei
gesetzt werden. Die absolute Sicherheitsgrenze von 500 begrenzt Datenbankabfrage
und Antwortgröße auch gegenüber internen Aufrufern.

Für die spätere Richtung LibreChat → MCP kann ein Betreiber beispielsweise
diesen YAML-Eintrag verwenden. Host, Schlüssel und MCP-Zeitlimits sind bei der
Bereitstellung des MCP-Dienstes konkret festzulegen:

```yaml
mcpServers:
  bfe-wissen:
    type: streamable-http
    url: https://wissen-mcp.example.internal/mcp
    startup: false
    requiresOAuth: false
    headers:
      Authorization: 'Bearer ${KNOWLEDGE_MCP_GATEWAY_KEY}'
      X-LibreChat-User-ID: '{{LIBRECHAT_USER_ID}}'
```

`KNOWLEDGE_MCP_GATEWAY_KEY` ist ein **anderer** Schlüssel als der Rückrufschlüssel.
Bei über die Benutzeroberfläche angelegten MCP-Servern werden die hier benötigten
Betreiber- und Benutzerplatzhalter nicht auf dieselbe Weise aufgelöst. Die
Gruppenprüfung des MCP-Dienstes gilt zusätzlich zu LibreChats eigenen Freigaben.

## Mitgliedschaftsabfrage

```http
POST /api/internal/mcp/groups
Authorization: Bearer <Rückrufschlüssel>
Content-Type: application/json

{"userId":"507f1f77bcf86cd799439011"}
```

Der Body darf ausschließlich eine kanonische lokale LibreChat-Benutzer-ID
enthalten: 24 kleine Hexadezimalzeichen. Es wird keine E-Mail-Adresse und keine
Entra-Objekt-ID angenommen.

```json
{
  "userId": "507f1f77bcf86cd799439011",
  "tenantId": null,
  "groupIds": ["507f1f77bcf86cd799439012"],
  "groups": [
    {
      "id": "507f1f77bcf86cd799439012",
      "name": "Qualitätsmanagement",
      "updatedAt": "2026-11-16T10:00:00.000Z"
    }
  ]
}
```

Die bestehenden Felder `userId`, `tenantId` und `groupIds` bleiben erhalten.
`groups` enthält dieselben Gruppen in derselben aufsteigenden ID-Reihenfolge;
bei fehlender Mitgliedschaft sind beide Listen leer.

Die Gruppen-IDs sind lokale, stabile LibreChat-IDs. Umbenennungen ändern die
Freigabezuordnung nicht. Externe und lokale Mitglieder werden nach LibreChats
bestehender Regel aufgelöst: `idOnTheSource`, sofern vorhanden, sonst lokale
Benutzer-ID. Rollen wie `ADMIN` erzeugen keine zusätzlichen Gruppenfreigaben.

Benutzer und Mitgliedschaften werden ohne den allgemeinen Berechtigungscache
direkt vom MongoDB-Primärknoten gelesen. Ein abgeschlossener Gruppenentzug wird
damit bei der nächsten Abfrage berücksichtigt. Die Antwort trägt
`Cache-Control: no-store`; der MCP-Dienst muss die Abfrage für jeden Datenzugriff
wiederholen und darf bei Fehlern nicht auf frühere Freigaben zurückfallen.

| Status | Bedeutung |
|---|---|
| `200` | Benutzer vorhanden; `groupIds` und `groups` können leer sein. Eine leere Liste erteilt keine Datenbankfreigabe. |
| `400` | Ungültiger Body, zusätzliche Felder oder ungültige Benutzer-ID. |
| `401` | Fehlender oder falscher Dienstschlüssel. |
| `404` | Route deaktiviert oder Benutzer in der Partition nicht vorhanden beziehungsweise in Löschung. |
| `503` | Fehlende/ungeeignete Schlüsselkonfiguration, unzulässiger Mandantenkontext oder fehlgeschlagene Datenbank-/Konfigurationsabfrage. |

Fehler liefern einen stabilen Code unter `error.code`. Interne Fehlermeldungen
und Datenbankzugänge gelangen nicht in die Antwort. Fehlende Freigaben und
`4xx`/`5xx` müssen im MCP-Dienst den jeweiligen Datenzugriff ablehnen.

## Vollständiger Gruppenkatalog

```http
GET /api/internal/mcp/group-catalog?limit=1
Authorization: Bearer <Rückrufschlüssel>
```

```json
{
  "tenantId": null,
  "groups": [
    {
      "id": "507f1f77bcf86cd799439012",
      "name": "Qualitätsmanagement",
      "updatedAt": "2026-11-16T10:00:00.000Z"
    }
  ],
  "nextCursor": "507f1f77bcf86cd799439012"
}
```

Der Katalog umfasst alle Gruppen der konfigurierten Partition, einschließlich
Gruppen ohne Mitglieder und externer Gruppen. Er enthält ausschließlich ID,
Name und Quellzeitpunkt, keine Mitgliederlisten, E-Mail-Adressen, externen IDs,
Beschreibungen oder Benutzerinformationen. Es wird keine Benutzer-ID benötigt.
Die vorhandenen Admin-Routen mit Benutzeranmeldung bleiben eigenständig;
der Dienstschlüssel verleiht keine Admin-Anmeldung.

Erlaubte Query-Parameter:

| Parameter | Vertrag |
|---|---|
| `limit` | Optional. Positive ganze Dezimalzahl ohne Vorzeichen oder führende Null, höchstens `groupCatalogPageSize`. Ohne Angabe gilt die Betreibergröße. Zu große Werte werden abgewiesen, nicht still gekürzt. |
| `cursor` | Optional. Exklusive untere Grenze als lokale Gruppen-ID aus `nextCursor`, genau 24 kleine Hexadezimalzeichen. Ohne Angabe beginnt der Durchlauf. |

Die Reihenfolge ist immer aufsteigend nach der unveränderlichen Gruppen-ID,
unabhängig von Namen und Umbenennungen. `nextCursor` enthält die letzte
zurückgegebene ID, wenn weitere Gruppen vorhanden sind; `null` beendet den
Durchlauf. Für die nächste Seite `cursor=<nextCursor>` übergeben. Auch die
letzte vollständig gefüllte Seite liefert `null`, wenn keine weitere Gruppe
existiert. Ein Cursor muss keine noch existierende Gruppe bezeichnen; die
Löschung der Cursor-Gruppe verhindert das Fortsetzen nicht. Der Cursor enthält
keine Mandantenauswahl; jede Seite bleibt auf die Betreiberpartition beschränkt.
Unbekannte, mehrfach angegebene oder strukturierte Parameter sowie ungültige
IDs und Seitengrößen liefern `400` mit `mcp_authorization_invalid_request`.

Jede Seite wird frisch vom MongoDB-Primary gelesen und trägt
`Cache-Control: no-store`. Ein Durchlauf ist kein transaktionsübergreifender
Snapshot: Gleichzeitige Änderungen können auf späteren Seiten sichtbar werden;
neu importierte IDs vor dem Cursor erscheinen erst beim nächsten vollständigen
Durchlauf. Der Client muss alle Seiten erfolgreich lesen, bevor er einen
Abgleich als vollständig behandelt. Nach einem Fehler den Durchlauf verwerfen
und neu beginnen; eine einzelne Seite oder Benutzerantwort beweist keine
Gruppenlöschung. Die ID-Grenze verhindert doppelte Ergebnisse beim Fortsetzen.

Für beide Routen gelten dieselbe Betreiberaktivierung, derselbe Rückrufschlüssel
und die Fehlercodes `401`, `404` (deaktiviert) und `503` aus der Tabelle oben.
Ein leerer Katalog liefert `200`, `groups: []` und `nextCursor: null`.

## Quellzeitpunkt für Gruppennamen

`groups[].updatedAt` ist auf beiden Routen der gespeicherte MongoDB-Zeitpunkt der
letzten Gruppenänderung in UTC/ISO 8601 mit Millisekunden. Eine Umbenennung
aktualisiert ihn; auch andere Gruppenänderungen können ihn fortschreiben.
Er ist kein Antwort- oder Synchronisierungszeitpunkt. Bei alten Importen ohne
`updatedAt` gilt `createdAt`, ersatzweise der stabile Erstellungszeitpunkt der
ObjectId. Die nächste reguläre Gruppenänderung setzt wieder `updatedAt`.
Ungültige Gruppenmetadaten führen zu `503` statt zu einer unvollständigen Antwort.

Die spätere Spiegelung vergleicht Zeitpunkte innerhalb desselben
LibreChat-Instanz-/Partitions-/Gruppen-Kontexts und darf einen neueren Namensstand
nicht mit einer älteren Antwort überschreiben. Bei gleichem Zeitpunkt mit
abweichendem Namen ist eine erneute Abfrage nötig; der Zeitstempel ist keine
streng monotone Revisionsnummer. Reguläre Namensänderungen müssen über die
LibreChat-Schreibpfade mit aktivierten Mongoose-Zeitstempeln erfolgen.
Direkte Datenbankänderungen ohne Zeitstempelpflege erfüllen diesen Vertrag nicht.

## Prüfen und bereitstellen

Die konkreten Schritte für `mediadev`, Image-Build, Konfiguration und Rückwechsel
stehen in [docs/bfe/librechat-update.md](librechat-update.md).

Lokal geprüft am 16.11.2026 auf der Erweiterung von `fb9091168c41`:

- 1.008 erfolgreiche Tests: Konfigurationsschema und bestehende Konfiguration
  (653), Datenbank-/Gruppenmethoden und Konfigurationszusammenführung (296),
  echte HTTP-Aufrufe mit isolierter MongoDB (59).
- `npx tsc --noEmit` in `packages/data-provider`, `packages/data-schemas` und
  `packages/api` sowie Builds aller drei Pakete. Die API-Typprüfung lief mit
  `NODE_OPTIONS=--max-old-space-size=8192`.
- ESLint, Prettier, Imports und zirkuläre Abhängigkeiten für die geänderten
  Quelldateien erfolgreich. Die Gates aus `static-checks:full` wurden für die
  benannten Dateien ausgeführt; die Typprüfungen wurden zusätzlich separat
  erfolgreich abgeschlossen. `static-checks --fast` besteht am finalen Stand.
- Weitere 54 Konfigurationsmigrationstests erfolgreich, vier Tests regulär
  übersprungen. Insgesamt damit 1.062 erfolgreiche Tests.
- Der vorgeschriebene Vergleich gegen `origin/dev` konnte wegen des lokal
  fehlenden Refs nicht starten; stattdessen wurden die geänderten Dateien
  explizit geprüft. Die optionale Abhängigkeitsprüfung wurde übersprungen,
  weil `depcheck` nicht installiert ist.
- `npm run lighthouse` einschließlich Produktionsbuild erneut ausgeführt.
  Das Browser-Setup scheitert vor der Messung beim Registrieren des Testbenutzers
  mit einem Timeout auf `Sign up` in `e2e/setup/authenticate.ts:25`.
  Erfolgreiche Lighthouse-Messwerte liegen weiterhin nicht vor.

Die Tests decken lokale und externe Identitäten, leere Gruppen, Umbenennungen,
Legacy-Zeitpunkte, vollständige Pagination mit verschiedenen Seitengrößen,
gelöschte Cursor-Gruppen, ungültige Eingaben, Mandanten einschließlich strikter
Trennung, Benutzerlöschung sowie Konfigurations-, Schlüssel- und Datenbankfehler
mit sicheren Antworten und Logs ab. SDK-Kompatibilität mit dem späteren
Python-MCP-Service ist weiterhin offen; diese Gruppenrouten führen keinen
MCP-Protokolltest aus.

Die Änderung betrifft `librechat-data-provider`, `@librechat/data-schemas` und
`@librechat/api` sowie die Express-Routenverdrahtung. Diese Pakete vor dem
Backend bauen; ein bestehendes offizielles LibreChat-Image enthält die
Erweiterung nicht. Für die produktive Installation ist ein eigenes
LibreChat-Image aus diesem Fork zu bauen und bereitzustellen.

Auf `mediadev` liegt LibreChat unter `/var/LibreChat`. Dort das eigene Image in
die bestehende Compose-Konfiguration eintragen und ENV/YAML bereitstellen.
Danach den vollständigen Stack mit dem vorhandenen Skript neu erstellen:

```bash
/var/LibreChat/recreate.sh
```

Das Skript muss `/var/LibreChat/docker-compose.yml` und
`/var/LibreChat/docker-compose.override.yml` gemeinsam verarbeiten und die
aktiven Profile berücksichtigen. Ein reiner Containerneustart übernimmt keine
geänderten Container-Umgebungsvariablen. Diese Anleitung beschreibt die spätere
Bereitstellung; eine Installation auf `mediadev` ist damit nicht erfolgt.

Vor Freigabe des MCP-Zugriffs ist ein realer Test mit zwei unterschiedlich
berechtigten Benutzern nötig: eigene Datenbank erlaubt, fremde Datenbank
abgewiesen, Gruppenentzug wirksam und Zugriff bei Ausfall der Gruppenabfrage
abgewiesen. Der spätere MCP-Dienst ist hierfür noch bereitzustellen.
