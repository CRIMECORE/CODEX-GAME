CREATE TABLE IF NOT EXISTS bot_state (
  id INT PRIMARY KEY,
  state JSON NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Игроки
CREATE TABLE IF NOT EXISTS players (
  id BIGINT PRIMARY KEY,
  username VARCHAR(64),
  name VARCHAR(128),
  hp INT,
  maxHp INT,
  infection INT,
  clanId INT,
  inventory JSON,
  monster JSON,
  monsterStun INT,
  damageBoostTurns INT,
  damageReductionTurns INT,
  radiationBoost BOOLEAN,
  firstAttack BOOLEAN,
  lastHunt BIGINT,
  pendingDrop JSON,
  pvpWins INT,
  pvpLosses INT,
  lastGiftTime BIGINT,
  huntCooldownWarned BOOLEAN,
  lastMainMenuMsgId BIGINT,
  currentBattleMsgId BIGINT,
  pvp JSON
);

-- Кланы
CREATE TABLE IF NOT EXISTS clans (
  id INT PRIMARY KEY,
  name VARCHAR(128),
  points INT,
  members JSON
);

-- Битвы кланов
CREATE TABLE IF NOT EXISTS clan_battles (
  id INT AUTO_INCREMENT PRIMARY KEY,
  data JSON
);

-- Приглашения в кланы
CREATE TABLE IF NOT EXISTS clan_invites (
  id INT AUTO_INCREMENT PRIMARY KEY,
  data JSON
);