# Konfiguracja własnej instalacji

Katalog konfiguracji zawiera dokładnie te pliki używane przez instalację:

| Plik | Znaczenie |
| --- | --- |
| `aktualizator.json` | Początek zakresu oraz strefa `Europe/Warsaw` |
| `zakres.json` | Akty NL przez BWB ID, artykuły lub ścieżki struktur |
| `zakres-ue.json` | Akty UE przez CELEX, wymagane wersje i dokumenty powiązane |
| `release-consumers.json` | Namespace i zaakceptowany kontrakt odczytu wydania |

Pliki przykładowe zawierają niewielki zakres. `order` musi być kolejny od 1.
Obsługiwana wersja językowa UE to **EN**. NL korzysta z oryginalnego tekstu NL.
`mustIncludeArticles` wymusza obecność wskazanych artykułów; nie wyłączaj tej
kontroli, aby ukryć brak źródła. Zmiana konfiguracji istniejącego korpusu podlega
kontroli zgodności dziennika; przy innym korpusie wybierz nowy namespace.

## Prywatna konfiguracja w publicznym repo

W środowisku GitHub **`updater`** dodaj opcjonalny sekret **`LAW_CONFIG_JSON`**.
Jest to JSON z czterema kluczami, których wartościami są obiekty z plików powyżej:

```json
{
  "aktualizator.json": {"schemaVersion":1,"rangeFrom":"2025-01-01","timeZone":"Europe/Warsaw"},
  "zakres.json": {"schemaVersion":2,"source":{"title":"My scope","derivedAt":"2026-11-13"},"acts":[]},
  "zakres-ue.json": {"schemaVersion":1,"language":"EN","acts":[]},
  "release-consumers.json": {"schemaVersion":1,"namespace":"production","approved":false,"consumers":[]}
}
```

To ilustracja opakowania, nie działający zakres: zastąp wartości kompletnymi
obiektami własnej konfiguracji. Puste zakresy nie spełniają wymagań programu.
GitHub ogranicza wielkość pojedynczego sekretu do 48 KB. Dla większego zakresu
użyj lokalnego katalogu albo świadomie publicznej konfiguracji w repo.
Nie kompresuj ani nie dziel sekretów bez dodatkowej, sprawdzonej obsługi.

Workflow zapisuje konfigurację w tymczasowym katalogu runnera z ograniczonymi
uprawnieniami i nie wypisuje jej treści. Same parametry workflow, np. data końcowa,
są publiczne. Program nie umieszcza konfiguracji w GitHub Artifacts.

Lokalnie użyj `--config-dir=/absolute/path` lub `LAW_CONFIG_DIR`. Wskazany katalog
jest tylko odczytywany. Foldery wynikowe, checkpointy i cache są zarządzane przez
program w katalogu aplikacji, a wyniki trwałe trafiają do zarządzanego magazynu Drive.

## Odczyt

`active.json` wskazuje niezmienne wydanie i folder przez `openFolder`. Zawsze
odczytuj ten wskaźnik na początku, a następnie oba moduły z tej samej generacji.
Nie zakładaj, że zapisany na stałe link do starego folderu pokaże kolejne wydanie.
Potwierdzenie tego kontraktu w `release-consumers.json` jest wymagane przed zapisem.
