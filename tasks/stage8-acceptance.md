# Etap 8 — odbiór publiczny (2026-11-14)

## Zakres i stan

Kontynuacja zatwierdzonego odbioru publicznego aktualizatora, bez harmonogramu, zmiany prywatnego `alwaysworks` ani osobnego eksperymentu retencji. Etapy 4–7 zostały scalone przez PR #7 do `main` (`e9ff5eca5076894d58afcdb9357b284794c7755c`). Wymagany check `verify` przeszedł przed i po scaleniu. Wcześniejsze ograniczenia publikacji zapisane w planie etapu 4 opisują historyczny zakres tego etapu; bieżący odbiór obejmuje uzgodniony test publiczny i naprawy jego usterek.

## Pierwszy pełny przebieg

Run [43587043021](https://github.com/staguak/aktualizator-nl-ue/actions/runs/43587043021), zwykły tryb przyrostowy (`full_source_audit=false`), zakończył się błędem budowania źródeł. Dotychczasowa poprawna publikacja pozostała aktywna. Zapisano próbę FAILED w Release `data-43587043021-1`, w tym runtime o rozmiarze 132 348 389 bajtów i checkpoint 48 ukończonych pozycji UE. Obsługa błędu, zapis cache i zwolnienie blokady wykonały się w normalnym przebiegu.

Potwierdzone przyczyny i poprawki:

- NL: urzędowe adresy `jci1.3:` były odrzucane przez renderer. Są teraz kierowane do `https://wetten.overheid.nl/`, z zachowaniem dokładnego źródłowego identyfikatora. Identyfikatory CELEX są kierowane do oficjalnego portalu, bez zgadywania ani poprawiania błędnych identyfikatorów w oryginalnych metadanych.
- UE: polskie sprostowania zawierają odmiany „dyrektywy”, „rozporządzenia”, „decyzji”, „Karty”. Walidator rozpoznawał jedynie część mianowników. Poprawiono wzorce, zachowując kontrolę języka, typu sprostowania, tożsamości i kompletności. Oryginalny XHTML `32024L1499R(02)` zapisano jako niewprowadzającą zmian w źródle próbkę regresji z hashem i adresem urzędowym.
- Szersza kontrola źródeł wykryła dodatkowo zagnieżdżone NL `plaatje/illustratie`: nazwa pliku `naam` wskazuje zasób obok XML. Renderer zachowuje tę nazwę, oryginalne atrybuty i wymiary oraz jeden obraz w widoku. Brak nazwy nadal blokuje przyjęcie.

## Weryfikacja poprawek

- 341 testów Node: PASS; oba sprawdzenia typów: PASS; self-test BWB: PASS.
- Lokalny odczyt 88 oryginalnych archiwów poprzedniej poprawnej bazy: 68 stanów NL + 98 dokumentów UE = 166 źródeł. Sprawdzono SHA źródła, parsowanie strukturalne, manifest, kolejność/hierarchię/lokalizacje i dokładną rekonstrukcję treści: 166 PASS, 0 FAIL. Zachowany pełny XHTML historycznego orzeczenia sprawdzono jako pełny dokument, zamiast starego selektora samej sentencji.
- Rzeczywiste pozostałe sprostowania `32012R1215R(08)` i `32004R0883R(09)` pobrano po PL zgodnie z preferencją EN→PL→NL→FR i zweryfikowano z metadanymi/RDF oraz profilem strukturalnym: PASS.
- Sprawdzono rzeczywisty urzędowy zasób `270482.png` wskazany w NL manifest/subitem; obraz jest pobierany z katalogu XML, bez konwersji.

Niezależny przegląd wykrył dodatkowe osłabienie odrzucania protokołów przy budowaniu adresu CELEX. Poprawkę ograniczono do samych identyfikatorów: `javascript:` pozostaje odrzucany, a istniejące adresy HTTPS pozostają niezmienione. Dodatkowy test odtworzył błąd przed poprawką i przeszedł po niej.

To nie jest jeszcze pozytywny odbiór końcowy. Pozostają: wymagany CI, drugi pełny test publiczny oraz kontrola opublikowanych paczek/indeksu i raport końcowy. Każdy kolejny rzeczywisty błąd musi być wyjaśniony i naprawiony przed uznaniem etapu za ukończony.
