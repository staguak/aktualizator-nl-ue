# Opcjonalny harmonogram

Repozytorium dostarcza ręczny workflow, bez aktywnego wyzwalacza czasowego.
Tryb cykliczny jest obsługiwany w kodzie. Aby świadomie go włączyć:

1. Zakończ inicjalizację i kontrolę własnej instalacji.
2. Dodaj do sekcji `on` w `.github/workflows/updater.yml`:

   ```yaml
   schedule:
     - cron: '17 5 * * 1'
   ```

3. Ustaw zmienną **repozytorium** `NL_EU_PAIRED_RELEASES_ENABLED` na `true`.
   Bez niej zadanie harmonogramu zostanie pominięte, a runner odrzuci próbę zapisu.
4. Jeśli środowisko `updater` wymaga recenzenta, każde uruchomienie będzie czekać
   na jego zatwierdzenie. To zachowuje kontrolę nad dostępem do sekretu.

Powyższy przykład to poniedziałek 05:17 **UTC**, a nie stała godzina lokalna.
GitHub może opóźniać zadania czasowe i wyłączać je w nieaktywnych repozytoriach.
Nie jest to usługa gwarantująca uruchomienie o konkretnej godzinie.
Uruchomienie cykliczne wykonuje `update` z pełnym audytem treści źródeł.
Ręczne `initialize`, `check`, `update`, `rollback` i `recover` pozostają dostępne.

Wyłączenie: ustaw zmienną na `false` i usuń wyzwalacz `schedule`. Nie usuwa to
danych ani możliwości uruchomienia ręcznego.
