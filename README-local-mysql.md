Локальная инструкция: MySQL + проект

1) Docker (рекомендуется)
- Убедитесь, что Docker Desktop запущен.
- Поднять базу данных:
  docker compose -f docker-compose.local.yml up -d

2) Переменные окружения
- В файле `.env` уже указаны локальные настройки MySQL по умолчанию:
  MYSQL_HOST=127.0.0.1
  MYSQL_PORT=3306
  MYSQL_USER=root
  MYSQL_PASSWORD=
  MYSQL_DATABASE=codex_game

- Для использования учётной записи из `docker-compose.local.yml` обновите `.env`:
  MYSQL_USER=devuser
  MYSQL_PASSWORD=devpass
  MYSQL_DATABASE=codex_game

3) Установка зависимостей и запуск проекта (PowerShell)
- Если PowerShell не разрешает запуск npm скриптов, можно запустить прямо `npm` из cmd или безопасно разрешить выполнение команд:
  # Запуск в cmd.exe (рекомендуется для обхода ExecutionPolicy в PowerShell)
  cmd /c "npm install"

- Или в PowerShell (как администратор, если нужно):
  Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser; npm install

- Запуск бота:
  npm start

4) Восстановление состояния
- Если у вас есть дамп из продовой Postgres, лучше вручную превратить структуру в JSON и вставить в таблицу `bot_state` — можно использовать скрипт или напрямую выполнить SQL:
  INSERT INTO bot_state (id, state) VALUES (1, '{...}') ON DUPLICATE KEY UPDATE state = VALUES(state);

5) Проверка
- Следите за логами контейнера и приложения. Если MySQL не подключается, проверьте пароль/порт.

6) Очистка
- Остановить и удалить контейнеры/данные:
  docker compose -f docker-compose.local.yml down -v

Если хочешь, могу добавить npm-скрипт типа `local:start` и `local:db` в `package.json` и создать удобный restore-скрипт для вставки `data.json` в базу.
