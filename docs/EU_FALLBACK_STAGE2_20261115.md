# Etap 2 — odzyskiwanie i kontynuacja po brakach, 2026-11-15

Status: zakończony lokalnie. Bez Actions, publikacji, push, PR ani zmian prywatnego repozytorium. Następny etap dotyczy osadzania Base64 i walidacji finalnej prezentacji.

## Wynik rzeczywistej próby klamry

Odzyskano grafikę `right accolade` dla załącznika VIII do `01992L0058-20190726` z urzędowej wersji polskiej. Angielski adres nadal zwraca 404; pobieranie zakończono po poprawnym wyniku PL, bez pobierania kolejnych języków.

- Źródłowy adres polskiej grafiki: `http://publications.europa.eu/resource/celex/01992L0058-20190726.POL.xhtml.r1.jpg`; transport wyłącznie HTTPS.
- Rozmiar: 680 bajtów; SHA-256 `3603058df35df751ed6c5f89ad5993b6279a3bc0be6a824c2d0337ebee09baa0`.
- Zachowano oryginalne bajty. Potwierdzono ten sam akt, wersję, kontekst załącznika i jednoznaczną reprezentację o odpowiadających cechach; nie wybierano podobnej grafiki z innego aktu.
- Polski oryginał XHTML: `https://publications.europa.eu/resource/cellar/08dbd0a1-e080-11e9-9c4e-01aa75ed71a1.0018.03/DOC_1`, SHA-256 `8fce33ae84fc47897226232507b52ceb1bda77633f6a67ea13eb9ce8d2a87911`.
- Indeks zapisuje faktyczny język, wersję, lokalizator w polskim dokumencie, oryginalne bajty XHTML zakodowane Base64 oraz przebieg prób EN → PL.

Różne tłumaczenia mają odmienne drzewa HTML, dlatego identyczny XPath nie jest jedyną dopuszczalną metodą dopasowania. Alternatywa wymaga jednoznacznej nazwy zasobu, zgodnych cech obrazu i tego samego merytorycznego kontekstu prawnego. Niejednoznaczne dopasowania są odrzucane.

W przerwanej sesji skrypt zwrócił mylący błąd zapisu: kopiowanie obiektu odpowiedzi pomijało nieenumerowalny getter `bytes` z plikowego cache. Naprawiono przekazywanie bajtów wprost i dodano regresję używającą takiego gettera.

## Obsługa niedostępności

- Wymagane teksty UE są sprawdzane w kolejności EN → PL → NL → FR, również po niepełnym lub niepoprawnym wyniku języka wcześniejszego. Wskazówki językowe katalogu nie zastępują faktycznych prób pobrania.
- Niepowodzenie wszystkich języków daje typowany wpis `eu-document-unavailable-v1`, zachowany we własnym katalogu aktu oraz archiwum źródeł. Pozostałe dokumenty są nadal przetwarzane.
- Dla brakującego dokumentu powstaje wyraźny komunikat o braku, bez zmyślonej treści i bez zastępowania aktu linkiem. Raport określa kompletność jako niepełną.
- Grafiki korzystają z tej samej kolejności języków, zatrzymującej się po sukcesie. Sprawdzane są tożsamość aktu i wersji, kontekst oraz natywne bajty. Zachowywany jest dowód pochodzenia z alternatywnego języka.
- Po wyczerpaniu prób grafika otrzymuje jawny wpis `unavailableImages`; pozostałe jednostki są nadal przetwarzane. Przetestowano przypadek niedostępnej grafiki poprzedzającej poprawny następny dokument.
- Uszkodzony Base64 również uruchamia próbę odzyskania. Awarie infrastruktury walidacji nie są maskowane jako brak źródła.
- Wyjątek dla dekoracyjnych flag pozostaje ograniczony do rozpoznanych nagłówków Dziennika Urzędowego UE.

## Weryfikacja

59 testów Node PASS w dziesięciu plikach: resolver obrazów, niedostępne dokumenty, języki, zakres spraw, grafiki, transport, Base64/MIME, checkpointy oraz wyjścia NL/UE. Obie kontrole TypeScript PASS. Osobna próba rzeczywistego urzędowego źródła potwierdziła pobranie klamry; nie jest to jeszcze pełny odbiór nowej wersji całej bazy.

Dowody: `/workspace/publication-review/20261115-stage2/`: `bracket.json`, `bracket-native.bin`, `bracket.log`, `test-results.json`, logi testów i typechecków. Oryginalne dane wejściowe pozostały bez zmian.

## Następny etap

Aktualizacja po przeglądzie w etapie 3: pusty, niekompletny lub niedostępny katalog główny nadal pozwala spróbować pobrać skonfigurowane dokumenty; niedostępność katalogu spraw zachowuje wybrane dokumenty do przetworzenia. Obie sytuacje mają oryginalny dowód diagnostyczny i oznaczenie niepełnego rozpoznania. Testy obejmują również audyt bezwarunkowy i oryginalny XHTML z BOM. Błędy dysku, walidatora oraz integralności cache nie są zamieniane na brak dokumentu. Niepełne checkpointy są ponawiane przy wznowieniu. Blokada `OUTPUT_INCOMPLETE` chroni aktywną poprawną publikację po zbudowaniu i sprawdzeniu wszystkich pozostałych dostępnych treści. Szczegóły i końcowe wyniki: `INLINE_BASE64_STAGE3_20261115.md`.

Finalne pliki mają otrzymać natywne grafiki jako Base64, pełną treść zamiast samych UE-REF, odwracalny zapis zmian prezentacji i walidację z oryginałami. Dostosowanie niezależnego audytu Python i kontrola całej reprezentacji wynikowej należą do etapu 3. Pełna regresja i sparowany odbiór rzeczywistych NL/UE, CI/test publiczny oraz dystrybucja pozostają dalszymi etapami planu.

Użyte umiejętności: Codex Dev Workflows `resume-interrupted-task` i `feature-development`. Próby oraz weryfikację wykonano lokalnymi Node/Python i kodem HTTPS programu. Dodatkowe wtyczki badawcze nie były potrzebne.
