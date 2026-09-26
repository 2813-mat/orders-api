import { MigrationInterface, QueryRunner } from 'typeorm';

export class Init1790449495556 implements MigrationInterface {
  name = 'Init1790449495556';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE \`products\` (\`id\` int UNSIGNED NOT NULL AUTO_INCREMENT, \`name\` varchar(120) NOT NULL, \`stock\` int UNSIGNED NOT NULL DEFAULT '5', \`created_at\` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), \`updated_at\` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), UNIQUE INDEX \`uq_products_name\` (\`name\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `CREATE TABLE \`orders\` (\`id\` char(36) NOT NULL, \`customer_name\` varchar(120) NOT NULL, \`total\` decimal(12,2) NOT NULL, \`status\` enum ('PENDING', 'PROCESSED', 'FAILED') NOT NULL DEFAULT 'PENDING', \`failure_reason\` varchar(255) NULL, \`processing_attempts\` int UNSIGNED NOT NULL DEFAULT '0', \`correlation_id\` char(36) NULL, \`created_by_sub\` char(36) NOT NULL, \`created_at\` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), \`updated_at\` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), \`processed_at\` datetime(3) NULL, INDEX \`idx_orders_created_by\` (\`created_by_sub\`, \`created_at\`), INDEX \`idx_orders_status_created\` (\`status\`, \`created_at\`), INDEX \`idx_orders_created_at\` (\`created_at\`, \`id\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `CREATE TABLE \`order_items\` (\`id\` bigint UNSIGNED NOT NULL AUTO_INCREMENT, \`order_id\` char(36) NOT NULL, \`product_id\` int UNSIGNED NOT NULL, \`product_name\` varchar(120) NOT NULL, \`quantity\` int UNSIGNED NOT NULL, \`unit_price\` decimal(12,2) NOT NULL, \`subtotal\` decimal(12,2) NOT NULL, INDEX \`idx_order_items_product\` (\`product_id\`), INDEX \`idx_order_items_order\` (\`order_id\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `CREATE TABLE \`stock_reservations\` (\`id\` bigint UNSIGNED NOT NULL AUTO_INCREMENT, \`order_id\` char(36) NOT NULL, \`product_id\` int UNSIGNED NOT NULL, \`quantity\` int UNSIGNED NOT NULL, \`created_at\` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), INDEX \`idx_stock_reservations_product\` (\`product_id\`), UNIQUE INDEX \`uq_stock_reservations_order_product\` (\`order_id\`, \`product_id\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `CREATE TABLE \`outbox_events\` (\`id\` char(36) NOT NULL, \`aggregate_type\` varchar(50) NOT NULL, \`aggregate_id\` char(36) NOT NULL, \`event_type\` varchar(100) NOT NULL, \`payload\` json NOT NULL, \`correlation_id\` char(36) NULL, \`status\` enum ('PENDING', 'PUBLISHED', 'FAILED') NOT NULL DEFAULT 'PENDING', \`attempts\` int UNSIGNED NOT NULL DEFAULT '0', \`last_error\` varchar(500) NULL, \`created_at\` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), \`published_at\` datetime(3) NULL, INDEX \`idx_outbox_aggregate\` (\`aggregate_id\`), INDEX \`idx_outbox_status_created\` (\`status\`, \`created_at\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `CREATE TABLE \`users\` (\`id\` int UNSIGNED NOT NULL AUTO_INCREMENT, \`keycloak_sub\` char(36) NOT NULL, \`username\` varchar(120) NOT NULL, \`email\` varchar(255) NULL, \`type\` enum ('USER', 'SERVICE_ACCOUNT') NOT NULL DEFAULT 'USER', \`first_seen_at\` datetime(3) NOT NULL, \`last_seen_at\` datetime(3) NOT NULL, UNIQUE INDEX \`uq_users_keycloak_sub\` (\`keycloak_sub\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `ALTER TABLE \`order_items\` ADD CONSTRAINT \`fk_order_items_order\` FOREIGN KEY (\`order_id\`) REFERENCES \`orders\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE \`order_items\` ADD CONSTRAINT \`fk_order_items_product\` FOREIGN KEY (\`product_id\`) REFERENCES \`products\`(\`id\`) ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE \`stock_reservations\` ADD CONSTRAINT \`fk_stock_reservations_order\` FOREIGN KEY (\`order_id\`) REFERENCES \`orders\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE \`stock_reservations\` ADD CONSTRAINT \`fk_stock_reservations_product\` FOREIGN KEY (\`product_id\`) REFERENCES \`products\`(\`id\`) ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );

    // Hand-written: TypeORM does not generate CHECK constraints for MySQL.
    // stock is already UNSIGNED; the CHECK documents the invariant in the schema.
    await queryRunner.query(
      `ALTER TABLE \`products\` ADD CONSTRAINT \`chk_products_stock\` CHECK (\`stock\` >= 0)`,
    );
    await queryRunner.query(
      `ALTER TABLE \`orders\` ADD CONSTRAINT \`chk_orders_total\` CHECK (\`total\` >= 0)`,
    );
    await queryRunner.query(
      `ALTER TABLE \`order_items\` ADD CONSTRAINT \`chk_order_items_quantity\` CHECK (\`quantity\` > 0)`,
    );
    await queryRunner.query(
      `ALTER TABLE \`order_items\` ADD CONSTRAINT \`chk_order_items_prices\` CHECK (\`unit_price\` >= 0 AND \`subtotal\` >= 0)`,
    );
    await queryRunner.query(
      `ALTER TABLE \`stock_reservations\` ADD CONSTRAINT \`chk_stock_reservations_quantity\` CHECK (\`quantity\` > 0)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`stock_reservations\` DROP CHECK \`chk_stock_reservations_quantity\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`order_items\` DROP CHECK \`chk_order_items_prices\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`order_items\` DROP CHECK \`chk_order_items_quantity\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`orders\` DROP CHECK \`chk_orders_total\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`products\` DROP CHECK \`chk_products_stock\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`stock_reservations\` DROP FOREIGN KEY \`fk_stock_reservations_product\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`stock_reservations\` DROP FOREIGN KEY \`fk_stock_reservations_order\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`order_items\` DROP FOREIGN KEY \`fk_order_items_product\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`order_items\` DROP FOREIGN KEY \`fk_order_items_order\``,
    );
    await queryRunner.query(
      `DROP INDEX \`uq_users_keycloak_sub\` ON \`users\``,
    );
    await queryRunner.query(`DROP TABLE \`users\``);
    await queryRunner.query(
      `DROP INDEX \`idx_outbox_status_created\` ON \`outbox_events\``,
    );
    await queryRunner.query(
      `DROP INDEX \`idx_outbox_aggregate\` ON \`outbox_events\``,
    );
    await queryRunner.query(`DROP TABLE \`outbox_events\``);
    await queryRunner.query(
      `DROP INDEX \`uq_stock_reservations_order_product\` ON \`stock_reservations\``,
    );
    await queryRunner.query(
      `DROP INDEX \`idx_stock_reservations_product\` ON \`stock_reservations\``,
    );
    await queryRunner.query(`DROP TABLE \`stock_reservations\``);
    await queryRunner.query(
      `DROP INDEX \`idx_order_items_order\` ON \`order_items\``,
    );
    await queryRunner.query(
      `DROP INDEX \`idx_order_items_product\` ON \`order_items\``,
    );
    await queryRunner.query(`DROP TABLE \`order_items\``);
    await queryRunner.query(
      `DROP INDEX \`idx_orders_created_at\` ON \`orders\``,
    );
    await queryRunner.query(
      `DROP INDEX \`idx_orders_status_created\` ON \`orders\``,
    );
    await queryRunner.query(
      `DROP INDEX \`idx_orders_created_by\` ON \`orders\``,
    );
    await queryRunner.query(`DROP TABLE \`orders\``);
    await queryRunner.query(`DROP INDEX \`uq_products_name\` ON \`products\``);
    await queryRunner.query(`DROP TABLE \`products\``);
  }
}
