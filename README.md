# Hotel Musik – Spotify-Zonensteuerung (PWA)

Web-App für das Samsung-Tablet. Jede Zone (Bar, Essbereich, Flure) bekommt einen eigenen
Spotify-Account, eine Playlist und einen Denon-Lautsprecher bzw. eine Lautsprechergruppe.
Gespielt wird über **Spotify Connect** – das Tablet ist nur die Fernbedienung.

## Voraussetzungen

- 3 × Spotify **Premium** (Free-Accounts können nicht ferngesteuert werden).
- Die Denon-Lautsprecher (HEOS) müssen in Spotify als Connect-Gerät erscheinen.
  Zonen in der HEOS-App als **Gruppen** anlegen (z. B. „Bar“, „Essbereich“, „Flure“).
- Hosting mit **HTTPS** (Spotify verlangt das für die Redirect-URI), z. B. GitHub Pages,
  ein eigener Webserver oder Netlify/Cloudflare Pages. Nur zum Testen am PC geht
  `http://127.0.0.1:8080/` (siehe unten).

> **Hinweis Lizenz:** Spotify erlaubt nur private, nicht-kommerzielle Nutzung. Für die
> Beschallung eines Hotels ist ein Business-Musikdienst vorgesehen (Lizenz/GEMA).

## 1. Spotify-Developer-App anlegen (einmalig)

1. <https://developer.spotify.com/dashboard> → *Create app*. Der Account, mit dem du die App im
   Dashboard anlegst, muss **Spotify Premium** haben – sonst antwortet Spotify später mit
   „Active premium subscription required for the owner of the app“.
2. **Redirect URI:** die Adresse, unter der die App später läuft (z. B.
   `https://meinhotel.github.io/hotel-musik/`). Die App zeigt sie unter
   *Einstellungen → Redirect-URI* an – sie muss **exakt** übereinstimmen (inkl. `/` am Ende).
3. *APIs used:* **Web API** ankreuzen.
4. Unter *User Management* die **E-Mail-Adressen aller 3 Spotify-Accounts** eintragen
   (im Development-Modus dürfen nur eingetragene Nutzer die App verwenden; erlaubt sind ein paar wenige).
5. **Client-ID** kopieren. Ein Client-Secret wird *nicht* gebraucht (PKCE).

## 2. App aufs Tablet bringen

1. Ordnerinhalt auf den HTTPS-Webspace laden (`index.html`, `app.js`, `style.css`, `sw.js`,
   `manifest.webmanifest`, `icon-*.png`).
2. Auf dem Tablet in **Chrome** die Adresse öffnen → Menü → *Zum Startbildschirm hinzufügen / App installieren*.

## 3. Einrichten

1. Zahnrad → **Client-ID** eintragen.
2. Pro Zone **Mit Spotify anmelden** und den passenden Account wählen.
   Ist im Browser schon ein anderer Account eingeloggt: auf der Spotify-Seite **„Nicht du?“**.
   Am einfachsten die drei Anmeldungen nacheinander im normalen Chrome-Tab erledigen.
3. **Lautsprecher** wählen. Erscheint der Lautsprecher nicht: einmal in der Spotify-App des
   jeweiligen Accounts (Handy im selben WLAN) auf das Gerät abspielen, dann „Aktualisieren“.
4. **Playlist** wählen → startet sofort.

Die Anmeldung bleibt gespeichert (Refresh-Token), es ist keine erneute Anmeldung nötig.

## Lokal testen (Windows)

```powershell
.\serve.ps1            # startet http://127.0.0.1:8080/
```

Als Redirect-URI im Dashboard `http://127.0.0.1:8080/` eintragen (Spotify erlaubt http nur für die Loopback-IP, nicht für `localhost`).

## Bekannte Grenzen

- Ob Spotify Connect auf eine **HEOS-Gruppe** sauber durchgereicht wird, hängt von Firmware/Modell ab –
  im Zweifel pro Zone einen Lautsprecher als Gruppen-Leader wählen.
- Lautstärke über Connect wird nicht von jedem HEOS-Gerät unterstützt; dann ist der Regler ausgegraut.
- Die App fragt den Status alle 4 Sekunden ab, solange sie im Vordergrund ist.
