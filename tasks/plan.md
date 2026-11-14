# Etap 4: struktura prawna Markdown i manifest jednostek

Zatwierdzony zakres: publiczny aktualizator NL/UE. Bez publikacji, merge, zmiany prywatnego repo, harmonogramu ani osobnego eksportu jednostek. Zachować źródła, wersje, kolejność, tabele, odsyłacze i obrazy. Granice plików mają być logiczne; 95 MB pozostaje zabezpieczeniem technicznym, nie celem pakowania. Dopuszczalny podział dużej jednostki tylko według jej rzeczywistych dzieci; brak bezpiecznej granicy blokuje publikację.

## Decyzje

- Wersjonowany profil `legal-structure-v1`, włączony w publicznej konfiguracji; odczyt starszych manifestów i dotychczasowe ścieżki pozostają dostępne.
- Wspólny katalog jednostek: korpus, akt/dokument, wersja i język, rodzic, rodzaj, etykieta, kolejność, identyfikatory źródłowe, lokalizator, powiązania z częściami. ID niezależne od fizycznych nazw plików.
- NL: pełne, osobne stany XML; czytelny widok HTML w Markdown zachowuje mieszany tekst, strukturę, tabele i zasoby. Istniejące sprawdzenia selektorów i historii artykułów nadal działają.
- UE: rozpoznanie kontenerów i nagłówków EN/PL/NL/FR; pełne artykuły, motywy, załączniki, orzeczenia, tabele i przypisy. Zachować działające sprawdzenia tożsamości, treści, obrazów i nawigacji.
- Manifest przechowuje dokładny przepis rekonstrukcji każdej wersji i zakresy jednostek. Porównanie oryginału, modelu i odtworzonego wyniku stanowi warunek przyjęcia; sama zgodność liczby jednostek nie wystarcza.

## Kolejność i kryteria

1. Wspólny model/manifest i odtwarzanie: jednoznaczne ID, poprawna hierarchia, kolejność, rozłączne pokrycie części; negatywne testy braków, powtórzeń i podmiany. Pliki: nowy moduł struktury i test.
2. Widok pełnego stanu NL: preambuła, rozdziały, artykuły/ustępy/punkty, załączniki/tabele/obrazy; zachowanie tekstu i źródłowych identyfikatorów. Pliki: nowy parser strukturalny NL i test.
3. Renderowanie/manifest NL: naturalne granice i osobne wersje, indeks jednostek, istniejące selektory i kontrola kompletności ze źródłem. Zależności: 1–2.
4. Widok UE: kontenery/nagłówki oraz rozpoznanie jednostek i naturalny podział bez celów znakowych. Integralność wszystkich treści i zasobów. Zależność: 1.
5. Renderowanie/manifest UE: integracja nawigacji i deduplikacji z lokalizatorami jednostek i przepisem odtworzenia. Zależności: 1, 4.
6. Walidacja/checkpointy: poprawne przyjęcie nowego profilu i odrzucanie utraty/duplikatów/złej wersji/odsyłaczy; nadal odczytywać stare dane. Zależności: 3, 5.
7. Publiczne wejścia/cache: włączenie profilu, zachowanie metadanych przy ponownym użyciu, usuwanie nieaktualnych części przez instalację całego zweryfikowanego zestawu. Zależność: 6.
8. Weryfikacja i raport: testy nowych kontraktów, regresja NL/UE, XML/checkpointy, kontrola typów i odtworzenie wybranych rzeczywistych źródeł. Nie wykonywać publikacji ani eksperymentu retencji.

Testy: repozytoryjne `npm run typecheck`, `npm run typecheck:tools`, `npm run parser:selftest`, odpowiednie `node --import tsx src/*.test.ts`, integracja XML i testy Python dotkniętych konsumentów. Listę postępu prowadzić w `tasks/todo.md`.

Ryzyka: mieszany XML NL i rzadkie struktury tabel; różne rodzaje XHTML UE; normalizacja/zmiana odsyłaczy po wyznaczeniu zakresów. Łagodzić przez zachowanie danych źródłowych, dokładne zakresy, finalizację indeksu po przygotowaniu widoku oraz niezależne porównanie treści i metadanych. Nie obniżać kontroli integralności w celu uzyskania PASS.

## Kontynuacja po etapie 4

Użytkownik polecił kontynuować kolejne etapy bez potwierdzeń między nimi. Zachowujemy bieżący plan i zapisujemy wyniki kolejno:

5. Obrazy NL/UE: bezstratne pliki graficzne, niezmienny Markdown/original, `IMAGE_INDEX.json` z powiązaniem do źródła, wersji i jednostek; grafiki wskazane w INDEX.
6. Paczka i audyt: walidacja pełnego pakietu, rzeczywiste języki EN→PL→NL→FR, jedna zbiorcza paczka źródeł na NL i UE; oryginały rozpakowane podczas audytu.
7. Dystrybucja: generator `distribution.json`, Releases i indeks `dane`, odtworzenie runtime/cache w workflow, retencja dwóch ostatnich prób oraz chronionej aktywnej bazy, cache po >7 GB do ≤4 GB. Bez harmonogramu; bez osobnego eksperymentu retencji.
8. Odbiór: końcowe kontrole lokalne i dostępny uzgodniony test publiczny; aktualizacja raportu i jawna lista ograniczeń/błędów.
