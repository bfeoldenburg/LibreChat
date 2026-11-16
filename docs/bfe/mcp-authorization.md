# Gruppenabfrage für den Wissensdatenbank-MCP-Dienst

Stand: 16.11.2026. Branch: `bfe/mcp-groups`. Basis ist der Fork-`main` bei
Commit `9363db541ecd4e23ab6a41dca47ca48ee2bd418e` vom 15.11.2026.

LibreChat verwaltet Benutzer und Gruppen. Der spätere MCP-Dienst verwaltet die
Zuordnung von **LibreChat-Gruppen-IDs zu Wissensdatenbanken** und prüft sie vor
jedem Datenzugriff. Die Freigabe gilt jeweils für die ganze Wissensdatenbank.

Diese Erweiterung stellt die dafür benötigte interne Gruppenabfrage bereit.
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
   MCP-Dienst an der neuen Gruppenabfrage. Dieser Schlüssel erlaubt das Lesen
   der Gruppenmitgliedschaften von Benutzern der konfigurierten Partition.
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

Ohne Konfiguration bleibt die Route deaktiviert. Nur die vom Betreiber
bereitgestellte `librechat.yaml` darf diese Vertrauensgrenze konfigurieren;
gespeicherte Basis-, Rollen-, Gruppen- oder Benutzerprofile können sie nicht
ändern.

```yaml
mcpAuthorization:
  enabled: true
  apiKeyEnv: MCP_AUTHORIZATION_API_KEY
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
Body und eingehende Mandanten-Header können diese Zuordnung nicht überschreiben.

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

## HTTP-Vertrag

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
  "groupIds": ["507f1f77bcf86cd799439012"]
}
```

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
| `200` | Benutzer vorhanden; `groupIds` kann leer sein. Eine leere Liste erteilt keine Datenbankfreigabe. |
| `400` | Ungültiger Body, zusätzliche Felder oder ungültige Benutzer-ID. |
| `401` | Fehlender oder falscher Dienstschlüssel. |
| `404` | Route deaktiviert oder Benutzer in der Partition nicht vorhanden beziehungsweise in Löschung. |
| `503` | Fehlende/ungeeignete Schlüsselkonfiguration, unzulässiger Mandantenkontext oder fehlgeschlagene Datenbank-/Konfigurationsabfrage. |

Fehler liefern einen stabilen Code unter `error.code`. Interne Fehlermeldungen
und Datenbankzugänge gelangen nicht in die Antwort. Fehlende Freigaben und
`4xx`/`5xx` müssen im MCP-Dienst den jeweiligen Datenzugriff ablehnen.

## Prüfen und bereitstellen

Die konkreten Schritte für `mediadev`, Image-Build, Konfiguration und Rückwechsel
stehen in [docs/bfe/librechat-update.md](librechat-update.md).

Lokal geprüft am 16.11.2026:

- 950 erfolgreiche Tests auf dem oben genannten `main`-Stand:
  Konfigurationsschema und bestehende Konfiguration (649), Benutzer-/Gruppenabfragen
  und Konfigurationszusammenführung (287) sowie HTTP-Integration mit einer
  isolierten MongoDB (14).
- `tsc --noEmit` in allen drei geänderten TypeScript-Paketen erfolgreich.
- Paket-Builds und die statischen Prüfungen für die geänderten Dateien
  einschließlich ESLint, Prettier, Imports und zirkulärer Abhängigkeiten erfolgreich.
- Die zusätzlichen Konfigurationsmigrationstests des Repositorys erfolgreich.
- `npm run lighthouse` einschließlich Produktionsbuild ausgeführt. Die Messung
  bleibt offen: Das Browser-Setup scheitert beim Registrieren des Testbenutzers
  mit einem Timeout auf den Link `Sign up` in `e2e/setup/authenticate.ts:25`.
  Es liegen damit keine erfolgreichen Lighthouse-Messwerte vor.

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
