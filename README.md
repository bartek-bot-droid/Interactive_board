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
- zapiski zapisują się na serwerze – po odświeżeniu strony wszystko zostaje,
- przycisk ze strzałką w dół pobiera **PDF z notatkami** (oryginalny PDF + wszystkie zapiski) – zrób to po każdej lekcji.

Skróty na komputerze: `1`–`5` – kolory, `[` / `]` – cieniej / grubiej, `E` – gumka, `Ctrl+Z` – cofnij, `Ctrl + kółko` – powiększenie.

## Uruchomienie na własnym komputerze

Wymaga [Node.js](https://nodejs.org) 18+.

```bash
npm install
npm start
```

Otwórz http://localhost:3000. Każde wejście bez linku tworzy nową tablicę; jej adres (`?b=...`)
to link, który wysyłasz uczniowi (przycisk **Link**).

iPad w tej samej sieci Wi-Fi może wejść na `http://<adres-IP-komputera>:3000`
(Windows może zapytać o zgodę zapory). Uczeń z innego miejsca potrzebuje wersji w internecie – poniżej.

## Publikacja w internecie (za darmo, Render.com)

1. Załóż konto na GitHub i wrzuć tam ten folder (bez `node_modules` i `data`).
2. Na https://render.com: **New → Blueprint** (albo **Web Service**) i wskaż repozytorium.
   Plik `render.yaml` ustawia wszystko sam (`npm install`, `npm start`).
3. Po kilku minutach dostaniesz adres typu `https://tablica-pdf.onrender.com`.

Uwagi o darmowym planie Render:
- serwer usypia po ~15 min bez ruchu; pierwsze wejście potem trwa ok. 30–60 s,
- dysk nie jest trwały – po uśpieniu/restarcie wgrane PDF-y i zapiski znikają.
  Na lekcję wystarczy wgrać PDF na początku. Jeśli zapiski mają zostawać na dłużej,
  potrzebny jest płatny dysk (Render „Disk”, ustaw zmienną `DATA_DIR` na jego ścieżkę) lub inny hosting.

Każdy, kto ma link do tablicy, może po niej pisać – nie publikuj linku publicznie.

## Pliki

- `server.js` – serwer (Express + Socket.IO): przechowuje PDF i kreski, rozsyła zmiany,
- `public/app.js` – wyświetlanie PDF (pdf.js), rysowanie, gesty, synchronizacja,
- `public/index.html`, `public/style.css` – wygląd.
