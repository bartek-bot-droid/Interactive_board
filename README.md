# Tablica PDF

Wspólna tablica na plikach PDF. Nauczyciel (np. iPad + Apple Pencil) i uczeń (np. komputer z rysikiem)
piszą po tych samych stronach i widzą zmiany na żywo.

- wgrywasz cały PDF (np. 30 stron) albo zdjęcia (kilka naraz, każde to osobna strona) i piszesz po każdej stronie,
- do trwającej tablicy możesz dokleić kolejne zdjęcia lub PDF na końcu – zapiski zostają,
- 5 kolorów pisaka (dotknij aktywnego koloru jeszcze raz, żeby go zmienić) i gumka,
- 4 grubości (cienki, średni, gruby, bardzo gruby) – działają dla pisaka i gumki,
- „Cofnij” (Ctrl+Z) cofa Twoją ostatnią kreskę, kosz czyści bieżącą stronę,
- na iPadzie: **rysik pisze, palec przewija**, dwa palce powiększają; dłoń oparta o ekran nie rysuje,
- przycisk z dłonią włącza rysowanie palcem (gdy nie masz rysika),
- zielona plakietka pokazuje, na której stronie jest druga osoba (kliknij, żeby tam przejść),
- tablice i zapiski zapisują się na stałe na serwerze (folder `data`),
- przycisk ze strzałką w dół pobiera **PDF z notatkami** (oryginalny PDF + wszystkie zapiski).

Skróty na komputerze: `1`–`5` – kolory, `[` / `]` – cieniej / grubiej, `E` – gumka, `Ctrl+Z` – cofnij, `Ctrl + kółko` – powiększenie.

## Moje tablice (PIN)

Sam adres strony (bez `?b=...`) otwiera listę tablic nauczyciela, chronioną PIN-em:
tworzenie tablic z nazwą i własnym kodem linku, zmiana nazwy, usuwanie, kopiowanie linku dla ucznia.
Przy pierwszym wejściu ustawia się PIN (4–8 cyfr). Po 5 błędnych próbach logowanie jest blokowane na 15 min.
Uczniowie wchodzą tylko przez link `https://…/?b=kod` – bez PIN-u.

Zapomniany PIN: zatrzymaj tablicę, usuń plik `data/_config.json` i uruchom ją ponownie –
przy następnym wejściu ustawisz nowy PIN (tablice zostają).

## Działanie na NAS Synology (Container Manager + Tailscale Funnel)

Folder na NAS: `docker/tablica` z plikami `docker-compose.yml`, `package.json`, `package-lock.json`,
`server.js` i folderem `public`. Folder `data` (tablice, PDF-y, PIN) tworzy się sam – **nigdy go nie nadpisuj ani nie usuwaj**.

1. Container Manager → **Projekt → Utwórz**, ścieżka `docker/tablica`, „użyj istniejącego docker-compose.yml”.
   Tablica działa wprost z plików w folderze (obraz `node:22-alpine`), na porcie 3000.
2. Dostęp z internetu: pakiet **Tailscale** na NAS + w panelu Tailscale włączone HTTPS i Funnel,
   a w Harmonogramie zadań (Uruchomione zadanie przy rozruchu, użytkownik root) skrypt:

   ```bash
   TS=/var/packages/Tailscale/target/bin/tailscale
   OUT="$(ls -d /volume*/docker/tablica | head -1)/funnel.txt"
   sleep 30
   $TS funnel --bg 3000 > "$OUT" 2>&1
   $TS funnel status >> "$OUT" 2>&1
   ```

### Aktualizacja na NAS

1. W File Station **usuń** stare wersje zmienionych plików i **wgraj nowe** (samo „nadpisz” bywa pomijane).
2. Container Manager → Projekt → tablica → **Akcja → Uruchom ponownie**.

## Uruchomienie na własnym komputerze (do testów)

Wymaga [Node.js](https://nodejs.org) 18+.

```bash
npm install
npm start
```

Otwórz http://localhost:3000.

Każdy, kto ma link do tablicy, może po niej pisać – nie publikuj linków publicznie.

## Pliki

- `server.js` – serwer (Express + Socket.IO): przechowuje PDF i kreski, rozsyła zmiany, lista tablic i PIN,
- `public/app.js` – wyświetlanie PDF (pdf.js), rysowanie, gesty, synchronizacja, eksport PDF (pdf-lib),
- `public/index.html`, `public/style.css` – wygląd tablicy,
- `public/tablice.html` – lista tablic nauczyciela,
- `docker-compose.yml` – uruchomienie na NAS.
