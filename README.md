# Hotel Musik – Spotify-Zonensteuerung (PWA)

Web-App für das Samsung-Tablet. Jede Zone (Bar, Essbereich, Flure …) bekommt einen eigenen
Spotify-Account, eine Playlist und einen Lautsprecher bzw. eine Lautsprechergruppe.
Gespielt wird über **Spotify Connect** – das Tablet ist nur die Fernbedienung.

## Funktionen

| Funktion | Beschreibung |
|---|---|
| **Zonenkarten** | Titel, Cover, Fortschritt, Play/Pause, Vor/Zurück, Zufall, Lautstärke je Zone |
| **Schnellwahl** | Bis zu 6 Lieblings-Playlists je Zone als Ein-Tipp-Kacheln (Stern im Playlist-Dialog) |
| **Spotify-Suche** | Im Playlist-Dialog auch Playlists suchen, die dem Account nicht gehören (erste 10 Treffer) |
| **Zeitplan** | Pro Zone Start / Pause / Lautstärke zu Uhrzeit und Wochentagen, mit „Jetzt ausführen“ zum Testen |
| **Wächter** | Startet die Wiedergabe neu, wenn sie unerwartet stoppt (Lautsprecher kurz offline, Playlist zu Ende) |
| **Lautstärke-Limit** | Maximale Lautstärke je Zone; Überschreitungen am Lautsprecher werden zurückgesetzt |
| **PIN-Schutz** | Die Einstellungen sind per 4-stelliger PIN gesperrt |
| **Bildschirm anlassen** | Verhindert die Bildschirmsperre, damit Zeitplan und Wächter laufen |
| **Alle pausieren / fortsetzen** | Ein Knopf für alle Zonen (z. B. für Durchsagen) |
| **Protokoll** | Was Zeitplan und Wächter getan haben, inkl. Fehlern |
| **Sicherung** | Export/Import von Zonen, Schnellwahl, Limits und Zeitplan als Datei |

Playlists werden automatisch auf „Wiederholen“ gestellt, damit die Musik nicht endet.

### Zeitplan – wichtig

- Termine laufen **nur, solange die App geöffnet ist und der Bildschirm an bleibt.** Es gibt keinen
  Server im Hintergrund. Unter *Einstellungen → Allgemein* „Bildschirm anlassen“ einschalten und
  das Tablet am Netzteil lassen. Samsung: *Einstellungen → Display → Bildschirm-Timeout* hoch stellen,
  Energiesparmodus für Chrome ausschalten.
- Verpasste Termine (z. B. Tablet kurz im Ruhezustand) werden bis 5 Minuten danach nachgeholt.
- „Start“ unterbricht eine bereits laufende, gleiche Playlist nicht, sondern setzt nur die Lautstärke.
- Neue oder geänderte Termine feuern nie rückwirkend.
- Für wirklich unbeaufsichtigten 24/7-Betrieb wäre ein kleiner Dauerläufer (z. B. Raspberry Pi) nötig,
  der die Termine übernimmt – das ist bewusst nicht Teil dieser App.

### Wächter

Je Zone unter *Einstellungen → Zonen* einschaltbar. Er greift nur ein, wenn die Zone zuletzt **über diese App**
gestartet wurde. Nach „Pause“ in der App bleibt es still. Nur für Accounts einschalten, die ausschließlich
dieser Zone dienen: Wird dieselbe Spotify-Sitzung nebenbei am Handy benutzt, holt der Wächter die Wiedergabe
zurück auf den Lautsprecher.

## Voraussetzungen

- Pro Zone ein Spotify-**Premium**-Account.
- Die Lautsprecher müssen in Spotify als Connect-Gerät erscheinen. Das gilt für Denon-HEOS-Geräte und für
  4Stream/Arylic-Verstärker. Mehrere Lautsprecher einer Zone in der **jeweiligen Hersteller-App als Gruppe**
  anlegen (HEOS-App bzw. 4Stream-App) und in dieser App die Gruppe wählen. HEOS- und 4Stream-Geräte lassen
  sich nicht gemeinsam gruppieren – eine Zone sollte aus einer Geräteart bestehen.
- Hosting mit **HTTPS** (Spotify verlangt das für die Redirect-URI). Aktuell:
  <https://heikoschimanski.github.io/hotel-musik/> (GitHub Pages).

> **Hinweis Lizenz:** Spotify erlaubt nur private, nicht-kommerzielle Nutzung. Für die
> Beschallung eines Hotels ist ein Business-Musikdienst vorgesehen (Lizenz/GEMA).

## 1. Spotify-Developer-App anlegen (einmalig)

1. <https://developer.spotify.com/dashboard> → *Create app*. Der Account, mit dem du die App anlegst,
   muss **Spotify Premium** haben – sonst antwortet Spotify mit
   „Active premium subscription required for the owner of the app“.
2. **Redirect URI:** die Adresse, unter der die App läuft (`https://heikoschimanski.github.io/hotel-musik/`).
   Die App zeigt sie unter *Einstellungen → Allgemein → Redirect-URI* an – sie muss **exakt** übereinstimmen
   (inkl. `/` am Ende).
3. *APIs used:* **Web API** ankreuzen.
4. Unter *User Management* die **E-Mail-Adressen aller Zonen-Accounts** eintragen (genau die E-Mail des
   Spotify-Accounts, ohne Leerzeichen). Im Development-Modus sind höchstens **5 Nutzer** erlaubt.
5. **Client-ID** kopieren. Ein Client-Secret wird *nicht* gebraucht (PKCE). Die aktuelle Client-ID ist in der
   App voreingestellt.

## 2. App aufs Tablet bringen

1. In **Chrome** die Adresse öffnen → Menü → *Zum Startbildschirm hinzufügen / App installieren*.
2. Updates kommen automatisch: nach dem Veröffentlichen die App ein- bis zweimal neu laden.

## 3. Einrichten

1. Pro Zone **Mit Spotify anmelden** und den passenden Account wählen.
   Ist im Browser schon ein anderer Account eingeloggt: auf der Spotify-Seite **„Nicht du?“**.
   Die Anmeldung in **einem** Browserfenster starten und beenden (nicht zwischen App und Chrome wechseln).
2. **Lautsprecher** wählen. Erscheint er nicht: einmal in der Spotify-App des jeweiligen Accounts
   (Handy im selben WLAN) auf das Gerät abspielen, dann „Aktualisieren“.
3. **Playlist** wählen → startet sofort. Mit dem Stern ⭐ wird sie zur Schnellwahl.
4. Optional unter *Einstellungen*: Limit, Wächter, Zeitplan, PIN.

Die Anmeldung bleibt gespeichert (Refresh-Token).

## Lokal testen (Windows)

```powershell
.\serve.ps1            # startet http://127.0.0.1:8080/
```

Als Redirect-URI im Dashboard zusätzlich `http://127.0.0.1:8080/` eintragen (Spotify erlaubt http nur für die
Loopback-IP, nicht für `localhost`).

## Bekannte Grenzen

- Ob Spotify Connect auf eine **Lautsprechergruppe** sauber durchgereicht wird, hängt von Modell und Firmware ab –
  im Zweifel pro Zone einen Lautsprecher als Gruppen-Leader wählen.
- Lautstärke über Connect wird nicht von jedem Gerät unterstützt; dann ist der Regler ausgegraut
  (und das Limit wirkungslos).
- Spotify-Development-Modus: höchstens 5 Nutzer, der App-Besitzer braucht dauerhaft Premium.
- Die PIN schützt vor versehentlicher Bedienung, nicht vor technisch versierten Personen
  (sie liegt als Hash im Browser-Speicher).
- Die App fragt den Status alle 4 Sekunden ab, solange sie im Vordergrund ist.
