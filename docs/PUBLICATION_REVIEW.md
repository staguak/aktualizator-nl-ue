# Kontrola dystrybucji publicznej — 13.11.2026

Kontrola dotyczy wybranego drzewa tej dystrybucji. Nie jest audytem ani
upublicznieniem historii wcześniejszych instalacji.

* Nowe repo ma własną historię. Nie kopiowano `.git`, historycznych raportów,
  archiwów odbioru, logów ani wyników produkcyjnych.
* Publiczna konfiguracja obejmuje zatwierdzone 23 akty NL i 65 pozycji UE.
  Usunięto prywatne odsyłacze do plików, archiwów i potwierdzenia z rozmowy.
  OAuth oraz dane prywatnej instalacji nie są częścią dystrybucji.
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
  otrzymuje sekretów. Opcjonalny workflow Drive wymaga środowiska `updater` i `main`.
  Wspólna baza używa osobnego workflow bez sekretów Drive.
* W plikach aktywnych workflow nie ma wyzwalacza `schedule`. Kod obsługuje
  świadome przyszłe włączenie harmonogramu z dodatkową zmienną aktywacyjną.
* Nie dołączono GitHub Artifacts, prywatnych identyfikatorów archiwów ani
  stałego adresu repo innej instalacji. Log działania jest przekierowany
  do pliku i zachowywany na prywatnym Drive przez istniejący protokół dowodów.
* Zawartość schematów pozostała bajtowo zgodna z przypiętym katalogiem.
  Zachowano licencję Apache-2.0 i atrybucję parsera oraz oznaczenia materiałów
  zewnętrznych. MIT nie zmienia ich warunków.

Wspólny korpus powstaje w osobnym workflow bez OAuth. Oba moduły przechodzą
walidację i niezależny audyt przed atomową publikacją na `dane`. Gałąź zachowuje
jeden bieżący snapshot bez poprzednich commitów; stare pliki są zastępowane,
a tymczasowe dane i cache są usuwane w kroku `always()`. Dodano siedem testów
żądań publicznych, cooldown, integralności snapshotu, konfliktu lease, zachowania
kodu, usuwania poprzedniej historii i sprzątania.

Dodatkowa ochrona `main` wymaga ustawienia właściciela. Próba zapisu reguły przez
integrację zwróciła 403; sama obecność kodu i instrukcji nie dowodzi jej aktywacji.

## Poprawki obsługi uruchomień — 13.11.2026

Wycofano kolejkę concurrency. Osobny atomowy rekord `updater-state` dopuszcza jednego
aktualizatora, odrzuca konkurentów oraz żądania opóźnione z czasu poprzedniej pracy.
Odzyskanie pozostawionej blokady wymaga potwierdzenia zakończenia konkretnej próby
w API Actions. Zwalnianie używa dokładnego lease i sprawdza właściciela.

Pełny audyt sam wymusza budowanie, a fingerprint plików wykonawczych oddzielono od
rewizji producenta. Odpowiedzi na błędy kontroli wstępnej są obsługiwane; komentarze
są ponawiane i uzgadniane po utraconej odpowiedzi, a błąd powiadomienia nie zmienia
wyniku publikacji. Zachowywane są bezpieczne kody i etapy błędów oraz wskazanie
kontroli niezależnego audytora, bez treści SDK i poświadczeń.
