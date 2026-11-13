# Kontrola dystrybucji publicznej — 13.11.2026

Kontrola dotyczy wybranego drzewa tej dystrybucji. Nie jest audytem ani
upublicznieniem historii wcześniejszych instalacji.

* Nowe repo ma własną historię. Nie kopiowano `.git`, historycznych raportów,
  archiwów odbioru, logów ani wyników produkcyjnych.
* Konfiguracja przykładowa jest mała i neutralna. Osobisty korpus, OAuth oraz
  potwierdzenia z prywatnej rozmowy nie są częścią dystrybucji.
* Zmieniono znacznik własności magazynu Drive. Program nie otwiera danych
  instalacji używającej innego znacznika. Nie dodano funkcji publicznego
  udostępniania plików Drive.
* Gitleaks **8.30.1**, z analizą zawartości archiwów: **0 wykrytych sekretów**.
  Dodatkowe porównanie z dostępnymi poświadczeniami i znanymi prywatnymi
  identyfikatorami Drive: **0 dopasowań**. Jest to wynik kontroli, nie gwarancja
  nieistnienia wszystkich możliwych danych wrażliwych.
* Zależności: `fast-xml-parser` **5.12.0**, npm audit **0** zgłoszeń.
  OSV dla przypiętych lxml, rdflib, pyparsing i PyYAML: **0** zgłoszeń.
* Node **24.22.1** i Python **3.12**: oba sprawdzenia TypeScript oraz self-test
  parsera PASS; **270** testów Node PASS, **14** integracji XML PASS,
  **26** testów Python XML PASS, **4** testy archiwów PASS i **4** testy granic
  publikacji/konfiguracji PASS. Nie wykonano eksperymentu retencji 72 godziny.
* Dodano testy działania kopii u innego właściciela, jawnej zgody na zapis,
  blokowania zapisu z PR/innej gałęzi, katalogu konfiguracji spoza repo,
  walidacji parametrów i osobnej końcowej kontroli bajtów po publikacji.
* Actions używa standardowego `ubuntu-24.04`, akcji przypiętych SHA,
  uprawnień `contents: read` i jednego zapisu naraz. Workflow testowy nie
  otrzymuje sekretów. Workflow danych wymaga środowiska `updater` i `main`.
* W plikach aktywnych workflow nie ma wyzwalacza `schedule`. Kod obsługuje
  świadome przyszłe włączenie harmonogramu z dodatkową zmienną aktywacyjną.
* Nie dołączono GitHub Artifacts, prywatnych identyfikatorów archiwów ani
  stałego adresu repo innej instalacji. Log działania jest przekierowany
  do pliku i zachowywany na prywatnym Drive przez istniejący protokół dowodów.
* Zawartość schematów pozostała bajtowo zgodna z przypiętym katalogiem.
  Zachowano licencję Apache-2.0 i atrybucję parsera oraz oznaczenia materiałów
  zewnętrznych. MIT nie zmienia ich warunków.

Kontrole kodu i paczki nie zastępują pierwszego odbioru danych na własnym
Drive. Właściciel musi skonfigurować OAuth, środowisko i zakres, a następnie
wykonać `initialize` i zweryfikować sposób odczytu przez `active.json`.
