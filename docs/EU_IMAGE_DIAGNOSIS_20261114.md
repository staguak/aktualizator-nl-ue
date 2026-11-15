# Etap 1: diagnoza obrazów UE — 2026-11-14

Status: **diagnoza zakończona; naprawy i pełny odbiór nadal otwarte**. Żadna kontrola kompletności nie została osłabiona.

## Zakres i baza dowodowa

Badano publiczny aktualizator na bazie `ccc6363b73dac766045c1fe5411c514a563fe64d`, gałąź `fix-eu-native-images-20261114`. Materiał: pełny lokalny kandydat UE `/workspace/publication-review/acceptance2/offline-eu`, 65 pozycji zakresu i 135 wpisów dokumentów. Kandydat odtworzono z checkpointów/oryginałów przebiegu odbiorowego nr 2 przy użyciu aktualnego mechanizmu strukturalnego. Nie wykonano porównania wszystkich oryginałów między przebiegami nr 2 i 3. Ostatni publiczny przebieg 43592013460 zakończył się błędem OUTPUT_VALIDATION; ten etap nie uruchamiał nowego przebiegu ani publikacji.

Spis wykorzystuje dokładny ekstraktor odwołań graficznych z `src/legal-images.ts` i rzeczywiście uwodniony manifest. Każde wystąpienie ma dokument, wersję/język, SHA oryginału i Markdown, plik, zakres pozycji, jednostkę prawną oraz lokalizator źródłowy. Pozycje są liczone w jednostkach kodowych UTF-16 w oprawionej treści prawnej, nie jako pozycje bajtowe.

Zapytania HTTP/RDF wykonano 2026-11-14 około 15:05–15:11 UTC; końcowy spis wygenerowano o 15:16 UTC. Wszystkie połączenia diagnostyczne korzystały z HTTPS. Oryginalne adresy `http:` zachowano jako dowód; zmieniono wyłącznie transport w odrębnym skrypcie badawczym.

## Pełny bilans

| Grupa | Wystąpienia w zakresach | Różne adresy/ładunki | Wynik |
| --- | ---: | ---: | --- |
| Osadzone `data:image/jpg;base64` | 71 | 71 natywnych JPEG | Wszystkie dekodują się i przechodzą kontrolę natywnych bajtów |
| Wzory prawne UE | 27 | 27 adresów | Dostępne: HTTP 200 po prawidłowej negocjacji MIME |
| Pozostałe zewnętrzne ilustracje | 4 | 4 adresy | Dostępne: HTTP 200 po prawidłowej negocjacji MIME |
| Dekoracyjna flaga nagłówka | 27 | 22 adresy | HTTP 404 pod adresami manifestacji; nadal bez oryginalnych bajtów |
| Znak grupowania tabeli `right accolade` | 1 | 1 adres | HTTP 404; znaczenie strukturalne potwierdzone w Formex |
| **Łącznie** | **130** | **54 zewnętrzne adresy + 71 osadzonych ładunków** | 125 fizycznych wystąpień po uwzględnieniu współdzielenia |

31 dostępnych adresów zewnętrznych zawiera 29 różnych ładunków SHA-256. Razem z osadzonymi obrazami dostępnych i poprawnych jest **100 różnych natywnych plików**. To nie jest deklaracja kompletności całego pakietu: pozostają 23 adresy obejmujące 28 wystąpień.

Pełna lista wszystkich 54 adresów z CELEX, zakresem, rolą, kodami HTTP, kanonicznym URI, wynikiem RDF, rozmiarem i SHA: [EU_IMAGE_DIAGNOSIS_20261114.csv](EU_IMAGE_DIAGNOSIS_20261114.csv). Szczegółowe 130 wystąpień wraz z powiązaniami są w lokalnym `inventory.json` w katalogu dowodowym.

## Przyczyny i kierunek naprawy

### 1. 31 grafik istnieje; problem dotyczy protokołu i nagłówka Accept

`src/package-images.ts` odrzuca wszystkie adresy inne niż HTTPS, a następnie wysyła `Accept: image/*`. 32 źródłowe odwołania w tym korpusie mają schemat HTTP, więc aktualny program odrzuci je przed próbą pobrania.

Dla 31 z tych adresów kontrolowana próba po HTTPS dała:

- `Accept: image/*` → HTTP 400, 31/31;
- `Accept: image/jpeg` → HTTP 200 i poprawny JPEG, 31/31;
- bezpośredni alias i kanoniczny element CELLAR → identyczny SHA-256 i rozmiar, 31/31;
- RDF `owl:sameAs` oraz łańcuch item → manifestation → expression → work → właściwy CELEX, język ENG i format XHTML → zgodność, 31/31.

Dotyczy to 30 adresów w `02006L0025-20190726` (27 wzorów i 3 ilustracje w załączniku II) oraz jednego w `01999L0092-20070627` (załącznik III). Wszystkie pobrano jako natywne JPEG; nie dokonywano konwersji.

**Wniosek dla etapu 2:** najpierw najmniejsza poprawka obsługi bezpiecznego transportu oficjalnych adresów i negocjacji MIME, z zachowaniem źródłowego URI oraz weryfikacji formatu. RDF dostarcza dowodu tożsamości i może służyć jako mechanizm rezerwowy. Nie ma podstaw, aby wymuszać zapytanie SPARQL dla każdego obrazu lub przebudowywać cały wybór reprezentacji, skoro poprawnie wysłane żądanie do oryginalnego aliasu zwraca te same bajty.

Sześć zakończonych zapytań RDF z powiązanym `VALUES ?alias` zwróciło odpowiednio 3, 10, 10, 8, 0, 0 wierszy, wszystkie z HTTP 200. Wcześniejszego timeoutu rozległego zapytania `FILTER IN` nie traktowano jako dowodu braku danych.

### 2. 71 obrazów osadzonych wymaga zgodności z aliasem MIME

Wszystkie 71 ładunków ma w źródle deklarację `image/jpg`, a faktycznie zawiera poprawny JPEG. To alias MIME, nie uszkodzenie obrazów. Scalony kod nie obsługuje jeszcze tej deklaracji. Robocza normalizacja do `image/jpeg` oraz jej test/próbka istniały przed tym etapem; nie zostały tu wdrożone ani scalone. Inspekcja wszystkich 71 oryginalnych ładunków w środowisku aplikacji (Pillow 13.0.0) zakończyła się PASS.

Kierunek: domknąć istniejącą zmianę i testy w etapie 3; zachować dokładnie te same bajty i oryginalny Markdown.

### 3. 22 adresy flag — nierozwiązany zasób współdzielony

Wszystkie 22 adresy `europeanflag.gif` zwróciły HTTP 404 zarówno dla `Accept: image/*`, jak i `image/gif`. Nie znaleziono dokładnego `owl:sameAs` dla ich wariantów HTTP/HTTPS w zakończonych zapytaniach. To wynik sprawdzonych dróg, nie dowód nieistnienia zasobu w całym urzędowym archiwum.

Dotknięte dokumenty: `32024L2831`, `32024L2831R(01)`, `62023CA0019`, `32024L1500`, `32024L1499`, `32025L2450`, `32026L2450`, `32024R0573`, `32024L1499R(02)`, `32026R2359`, `32024R1689`, `32024R1689R(01)`, `32024R1689R(02)`, `32024R1689R(04)`, `32026R1744`, `32024L1760R(01)`, `32024L1760R(02)`, `32025L0794`, `32026L0470`, `32024L1385`, `32025L2450R(01)`, `62022CA0649`.

Sprawdzony wspólny adres `https://eur-lex.europa.eu/images/europeanflag.gif` zwrócił HTTP 202, `text/html; charset=UTF-8`, bez bajtów GIF. Nie uznano odpowiedzi za grafikę. Przykładowa paczka XHTML dla `32024L2831` zawiera sam plik HTML i nie dostarcza flagi.

Kierunek: odnaleźć dokładny zasób urzędowy i zachować dowód pochodzenia. Ewentualny wyjątek dla dekoracyjnej flagi wymaga rozstrzygnięcia użytkownika; dotychczasowy rygor kompletności nadal obowiązuje. Nie zastępować podobną flagą i nie pomijać odwołania po cichu.

### 4. `r1.jpg` — znaczący znak grupowania tabeli

Dokument `01992L0058-20190726`, załącznik VIII. Oryginalny adres: `http://publications.europa.eu/resource/celex/01992L0058-20190726.ENG.xhtml.r1.jpg`, alt `right accolade`, rozmiar deklarowany 16 × 160. Po HTTPS oba nagłówki Accept dają HTTP 404; nie znaleziono dokładnego aliasu RDF. Wspólny kandydat EUR-Lex `/images/r1.jpg` zwrócił HTTP 202 i typ HTML, więc nie dostarczył JPEG.

Znak grupuje polecenia forwards/backwards/right/left z tekstem „to be coordinated with the corresponding hand signals”. Oryginalny Formex potwierdza to w `CL1992L0058EN0030010.0001.xml`:

```xml
<CELL ACCV="004.R.R" COL="2" ROWSPAN="4">to be coordinated with the corresponding hand signals</CELL>
```

Paczka Formex zawiera 64 pliki: 62 TIFF i 2 XML, bez `r1.jpg`. Paczka XHTML zawiera tylko HTML: jest identyczny z użytym oryginałem (SHA-256 `8c4e6871b305d86722013431973817cdeac5a425b6c3918ea46929ced5143a9a`), ma 61 osadzonych obrazów i jedno zewnętrzne odwołanie do klamry. Samo przejście na pobieranie paczki XHTML nie rozwiąże tego braku.

Kierunek: urzędowy zasób typograficzny albo osobno zaprojektowana i zatwierdzona wierna reprezentacja struktury ACCV/ROWSPAN. Tego znaku nie można objąć domniemanym wyjątkiem dla flagi; nie wolno fabrykować zastępczego JPEG ani usuwać go bez rozstrzygnięcia.

### 5. Dodatkowy błąd niezależnego audytu: dokumenty współdzielone

`aktualizator-ph/scripts/verify_official_output.py` dopasowuje dokument obrazu po `(documentId, version, language)` i wymaga dokładnie jednego wyniku. W rzeczywistym manifeście pięć dokumentów występuje w dwóch zakresach, mimo że wskazują ten sam fizyczny Markdown i wersję:

| Dokument | Zakresy | Wynik bieżącego predykatu |
| --- | --- | --- |
| `32024L1500` | `32006L0054` / `32024L1500` | 2 zamiast 1 |
| `32024L1499` | `32000L0043` / `32024L1499` | 2 zamiast 1 |
| `32025L2450` | `32009L0038` / `32025L2450` | 2 zamiast 1 |
| `32026R2359` | `32004R0883` / `32009R0987` | 2 zamiast 1 |
| `32026R1744` | `32024R1689` / `32026R1744` | 2 zamiast 1 |

Zapisano kontrolę tego samego predykatu na faktycznym manifeście w `shared-occurrence-audit.json`. To potwierdzona przyszła blokada audytu po domknięciu obrazów; nie przyczyna aktualnego przerwania wcześniejszej fazy pobierania. Kierunek: zgodna obsługa współdzielenia i tożsamości, bez osłabienia kontroli SHA, jednostek i pochodzenia; test regresyjny w etapie 3.

## Metoda, ograniczenia i narzędzia

Użyto Codex Dev Workflows `bug-investigation` do rozdzielenia objawów i przyczyn, Engineering Guardrails `code-verification` do wiązania ustaleń z dowodami, oraz Exa do odczytu urzędowych instrukcji EUR-Lex. Spis i próby wykonano lokalnymi skryptami Node/Python, HTTP/SPARQL oraz natywnym walidatorem obrazów aplikacji. Nie było potrzeby uruchamiania pozostałych wtyczek ani nowego odczytu GitHub API.

Urzędowe materiały:

- https://eur-lex.europa.eu/content/help/data-reuse/reuse-contents-eurlex-details.html
- https://eur-lex.europa.eu/content/tools/Retrieval_machine-readable_formats.pdf

W tym etapie nie zmieniono kodu produkcyjnego ani testów. Dodano raport i CSV oraz uaktualniono plan/checklistę. Wcześniejsze robocze zmiany MIME pozostały na miejscu. Nie uruchamiano Actions, publikacji, scalania, harmonogramu ani testu retencji; nie modyfikowano prywatnego repozytorium. Pełna regresja i audyt gotowego pakietu należą do późniejszych etapów. Wyniki HTTP są obserwacją z podanych dat, nie gwarancją przyszłej dostępności serwisu.

## Ślady dowodowe

Katalog lokalny: `/workspace/publication-review/stage1-eu-images/`. Zawiera pełny spis, odpowiedzi RDF/HTTP, natywne bajty, użyte skrypty i maszynowe podsumowanie `summary.json`. Surowych źródeł i grafik nie dodano do Git.

| Plik dowodowy | Bajty | SHA-256 |
| --- | ---: | --- |
| `inventory.json` | 261255 | `77368f88f9e30e8b6dfd2073774063335021b394e549b927cdf1e83866fdaf31` |
| `external-diagnosis.json` | 200729 | `389f13908a368c2244ae508edb8651526e4eeb9ab6b75eba2c7508ef966b6deb` |
| `embedded-validation.json` | 26016 | `6ad78f27138cd2591c5fece5ac9f69d74cd0162c93e9fb7f8b5ad82eaabaff48` |
| `direct-probes.json` | 49314 | `0997721726717ab00959eb14134a02da48dae5a94a477979d7ac74a387287195` |
| `exact-mime-probes.json` | 90385 | `4be31847b77e7b796a9b3e3b15fe9f73449fe2e256f2cf1b5a6365aa80320ea3` |
| `rdf-values-probes.json` | 110843 | `2670398520e969f0dabf8b5389ef7f55ba07d328dc6261b19961895cb369fbe2` |
| `shared-occurrence-audit.json` | 1667 | `f146d5c0ae938c3005df54be1430b389a5c03cbb9dbfa3a1fe2d12478ca93367` |
| `supplemental-probes.json` | 1131 | `bd490d1a5da87c83baa32872a7546d58a1a10b7bbef41aac218f9ba6d24752d3` |
| `references-exact.mts` | 2226 | `4b281185b767afd4a104f2a09019ef080f8c10983142375efb86b9d5a62a6fbc` |
| `EU_IMAGE_DIAGNOSIS_20261114.csv` | 29756 | `0e6c7d1f3380181716b41ed7d49bfee823ada4bdb4b4bc58e40b38633de532cb` |

Dodatkowe archiwa lokalne, katalog `acceptance2`: `1992-fmx.zip` SHA-256 `80b77053dcdd0c4c01de149c50dda2179c56c64da774871bbde211b86b7b1b54`; `1992-xhtml.zip` SHA-256 `9997f53bf17a161af372fd3010637ecf72c9c5ebf0cc8071932e337d20fead77`. XML z dowodem ACCV: SHA-256 `22a13e7bb2e6d20a674a562611d52f63f5bd3a1f83cc8b0b1401a2df82c22e73`.

## Stan po etapie

Etap 1 zakończony: wszystkie 130 wystąpień i 54 adresy sklasyfikowano, wskazano dowody, przyczyny techniczne i kierunki odzyskania. Nie wszystkie oryginalne grafiki są już odzyskane. Etap 2 nie został rozpoczęty; pozostają następnie MIME/audyt, pełny odbiór, CI/test publiczny i kontrola dystrybucji.
