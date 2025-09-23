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
  survivalDays INT,
  bestSurvivalDays INT,
  clanId BIGINT,
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
  currentDanger JSON,
  currentDangerMsgId BIGINT,
  baseUrl VARCHAR(512),
  pvp JSON,
  extra JSON,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Кланы
CREATE TABLE IF NOT EXISTS clans (
  id BIGINT PRIMARY KEY,
  name VARCHAR(128),
  points INT,
  members JSON,
  extra JSON,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Битвы кланов
CREATE TABLE IF NOT EXISTS clan_battles (
  id BIGINT PRIMARY KEY,
  clanId BIGINT,
  opponentClanId BIGINT,
  status VARCHAR(32),
  createdAt BIGINT,
  acceptedBy BIGINT,
  data JSON,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Приглашения в кланы
CREATE TABLE IF NOT EXISTS clan_invites (
  playerId VARCHAR(64) PRIMARY KEY,
  clanId BIGINT,
  fromId BIGINT,
  expires BIGINT,
  extra JSON,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
