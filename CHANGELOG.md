# Changelog

## [0.4.0](https://github.com/Cadenway/cadenway-storage-service/compare/v0.3.0...v0.4.0) (2026-11-23)


### Features

* **attachments:** admit only verified bytes within the free plan ([#32](https://github.com/Cadenway/cadenway-storage-service/issues/32)) ([dbc63d8](https://github.com/Cadenway/cadenway-storage-service/commit/dbc63d8645e54054718c14d7e1e5eb4f1a2f8d28))
* **attachments:** export authoritative search projections ([#30](https://github.com/Cadenway/cadenway-storage-service/issues/30)) ([5856f56](https://github.com/Cadenway/cadenway-storage-service/commit/5856f56c342fc3f8a2e631315f2486ac06ca645b))
* **attachments:** expose signed billing usage snapshots ([#31](https://github.com/Cadenway/cadenway-storage-service/issues/31)) ([b9cffdf](https://github.com/Cadenway/cadenway-storage-service/commit/b9cffdf73e5c87c8589b4f623173d84248c1e7ba))
* **storage:** add intake attachments and profile media ([#29](https://github.com/Cadenway/cadenway-storage-service/issues/29)) ([768687c](https://github.com/Cadenway/cadenway-storage-service/commit/768687cf18c54d03e7f160a24d4788fe9e7ea9d5))
* **storage:** enforce versioned Billing byte entitlements ([#34](https://github.com/Cadenway/cadenway-storage-service/issues/34)) ([9751fe1](https://github.com/Cadenway/cadenway-storage-service/commit/9751fe1930dc28c2303def675de354176dfca19d))
* **storage:** manage signed task attachments ([#27](https://github.com/Cadenway/cadenway-storage-service/issues/27)) ([3a5ae46](https://github.com/Cadenway/cadenway-storage-service/commit/3a5ae46e593adfde9f17e78836f85dbff81b3f01))


### Bug Fixes

* **storage:** enforce transfer mode and preserve inspected staging versions ([#36](https://github.com/Cadenway/cadenway-storage-service/issues/36)) ([b618c24](https://github.com/Cadenway/cadenway-storage-service/commit/b618c24b29ab2e7195102de8d779f5a68ba00f6c))
* **storage:** protect versioned files and make local transfers one shot ([#35](https://github.com/Cadenway/cadenway-storage-service/issues/35)) ([69ce40b](https://github.com/Cadenway/cadenway-storage-service/commit/69ce40bd0eee1ff664fced0e7f1e332bd61438f1))
* **storage:** schedule cleanup for quota-denied copies ([#33](https://github.com/Cadenway/cadenway-storage-service/issues/33)) ([a88a2dc](https://github.com/Cadenway/cadenway-storage-service/commit/a88a2dcdad004c4abfdb5219343875974b30662f))

## [0.3.0](https://github.com/Cadenway/cadenway-storage-service/compare/v0.2.0...v0.3.0) (2026-11-16)


### Features

* wire messaging and the outbox onto nest-common 0.3.0 ([#19](https://github.com/Cadenway/cadenway-storage-service/issues/19)) ([f6a014c](https://github.com/Cadenway/cadenway-storage-service/commit/f6a014c9a85c9564ecdf1aeeb55fbccfb7929540))


### Bug Fixes

* **deploy:** keep the migrator url out of the running service ([#21](https://github.com/Cadenway/cadenway-storage-service/issues/21)) ([39df200](https://github.com/Cadenway/cadenway-storage-service/commit/39df20016562d74ab7ae2df9c38489ea33e4f169))

## [0.2.0](https://github.com/Cadenway/cadenway-storage-service/compare/v0.1.0...v0.2.0) (2026-11-15)


### Features

* wire the service onto the published service kit ([#16](https://github.com/Cadenway/cadenway-storage-service/issues/16)) ([010efdf](https://github.com/Cadenway/cadenway-storage-service/commit/010efdfd80ca619c8e38a49373bd83c80e78783a))

## 0.1.0 (2026-11-12)


### Bug Fixes

* **deploy:** sign the deploy commits with the bot's noreply address ([#3](https://github.com/Cadenway/cadenway-storage-service/issues/3)) ([ac30b22](https://github.com/Cadenway/cadenway-storage-service/commit/ac30b22a023e4ea609b924517fe1a0c2dd0b4a2e))
