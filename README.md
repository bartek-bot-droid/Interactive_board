# Tablica PDF

Wspólna tablica na plikach PDF. Nauczyciel (np. iPad + Apple Pencil) i uczeń (np. komputer z rysikiem)
piszą po tych samych stronach i widzą zmiany na żywo.

- wgrywasz cały PDF (np. 30 stron) albo zdjęcia (kilka naraz, każde to osobna strona) i piszesz po każdej stronie,
- przycisk **+** między stronami wstawia w to miejsce **pustą stronę na notatki** (od razu, u wszystkich)
  albo zdjęcia / PDF; kosz pozwala wyczyścić zapiski albo usunąć całą stronę,
- 5 kolorów pisaka (dotknij aktywnego koloru jeszcze raz, żeby go zmienić) i gumka,
- 4 grubości (cienki, średni, gruby, bardzo gruby) – działają dla pisaka i gumki,
- „Cofnij” (Ctrl+Z) cofa Twoją ostatnią kreskę, kosz czyści bieżącą stronę,
- na iPadzie: **rysik pisze, palec przewija**, dwa palce powiększają; dłoń oparta o ekran nie rysuje,
- przycisk z dłonią włącza rysowanie palcem (gdy nie masz rysika),
- zielona plakietka pokazuje, na której stronie jest druga osoba (kliknij, żeby tam przejść),
- tablice i zapiski zapisują się na stałe na serwerze (folder `data`),
- przycisk ze strzałką w dół pobiera **PDF z notatkami** (wszystkie strony + zapiski).

### Szybkość (wolne łącze przez Tailscale Funnel)

- tablica pamięta **listę stron**: pusta strona to tylko wpis na liście, zdjęcie/PDF wysyła się raz jako osobny plik –
  nic nie jest przebudowywane ani pobierane od nowa,
- po otwarciu od razu widać układ stron i zapiski; PDF doczytuje się kawałkami (pasek „Pobieranie PDF… 45%”),
- pobrany (albo wgrany z tego urządzenia) PDF zostaje w pamięci przeglądarki – kolejne otwarcie nie pobiera go z sieci,
- w domu najszybciej przez adres NAS-a w sieci domowej (`http://<IP-NAS>:3000`); przycisk **Link** i tak poda
  uczniowi adres internetowy (zapamiętany, gdy nauczyciel otworzy listę tablic przez adres internetowy).

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
   Po wgraniu porównaj rozmiary plików z tymi na komputerze.
2. Container Manager → Projekt → tablica → **Akcja → Uruchom ponownie**.
   „Kompilacja” nie jest potrzebna (i nie wczytuje nowych plików).

### Do wgrania przy następnej aktualizacji NAS

Zmiany gotowe w repozytorium, ale jeszcze **niewgrane na NAS** (7.11.2026 – przyspieszenie, lista stron):

- [ ] przed aktualizacją: kopia folderu `data` (np. `data-kopia-2026-11-07`) – przy pierwszym otwarciu każda tablica
  przechodzi na nowy format (lista stron) i stara wersja programu nie umie go już czytać,
- [ ] `server.js` (22.2 KB) – lista stron, osobne pliki, kompresja, czyste zamykanie przy restarcie,
- [ ] `package.json` (431 B) i `package-lock.json` (68.2 KB) – nowa biblioteka `compression`
  (instaluje się sama przy „Uruchom ponownie”, potrzebny internet),
- [ ] `public/app.js` (45.7 KB), `public/index.html` (6.2 KB), `public/style.css` (8.2 KB), `public/tablice.html` (20.1 KB).

Po wgraniu odhacz pozycje albo usuń je z listy.

## Uruchomienie na własnym komputerze (do testów)

Wymaga [Node.js](https://nodejs.org) 18+.

```bash
npm install
npm start
```

Otwórz http://localhost:3000.

Każdy, kto ma link do tablicy, może po niej pisać – nie publikuj linków publicznie.

## Pliki

- `server.js` – serwer (Express + Socket.IO): lista stron, pliki (`data/assets/<tablica>/`), kreski, lista tablic i PIN;
  stare tablice (jeden PDF `data/<tablica>.pdf`) przenosi automatycznie przy pierwszym otwarciu,
- `public/app.js` – wyświetlanie stron (pdf.js), rysowanie, gesty, synchronizacja, eksport PDF (pdf-lib),
- `public/index.html`, `public/style.css` – wygląd tablicy,
- `public/tablice.html` – lista tablic nauczyciela,
- `docker-compose.yml` – uruchomienie na NAS.
