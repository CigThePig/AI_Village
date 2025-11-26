const CONSTANTS = {
  CELL_SIZE: 16,
};

class Ant {
  constructor(x, y, type = 'worker') {
    this.pos = { x, y };
    this.vel = { x: 0, y: 0 };
    this.hasFood = false;
    this.returnDir = null;
    this.shareTargets = [];
    this.energy = 100;
    this.maxEnergy = 100;
    this.type = type;
    this.isDead = false;
    this.carryingCorpse = false;
    this.targetCorpse = null;
    this.age = 0;
    this.lifespan = 300 + Math.random() * 200;
  }

  transferEnergy(recipient) {
    const TRANSFER_AMOUNT = 30;
    if (this.energy <= 0 && !this.hasFood) {
      return;
    }
    this.energy = Math.max(0, this.energy - TRANSFER_AMOUNT);
    const recipientMax = typeof recipient.maxEnergy === 'number' ? recipient.maxEnergy : 100;
    recipient.energy = Math.min(recipientMax, (recipient.energy || 0) + TRANSFER_AMOUNT);
    this.shareTargets.push(recipient);
  }

  update(dt, ants) {
    this.age += dt;

    if (this.isDead) {
      return;
    }

    // Metabolism
    this.energy = Math.max(0, this.energy - 2.5 * dt);

    // Self-feeding when hungry
    if (this.hasFood && this.energy < 30) {
      this.hasFood = false;
      this.energy = this.maxEnergy;
      this.returnDir = null;
    }

    if (this.age > this.lifespan || this.energy <= 0) {
      this.energy = 0;
      this.isDead = true;
      this.type = 'corpse';
      return;
    }

    // Trophallaxis (sharing)
    if (Array.isArray(ants)) {
      for (const other of ants) {
        if (other === this) continue;
        const dx = other.pos.x - this.pos.x;
        const dy = other.pos.y - this.pos.y;
        const dist = Math.hypot(dx, dy);
        if (dist < CONSTANTS.CELL_SIZE) {
          if ((this.energy > 80 || this.hasFood) && other.energy < 40) {
            this.transferEnergy(other);
          } else if ((other.energy > 80 || other.hasFood) && this.energy < 40) {
            other.transferEnergy(this);
          }
        }
      }
    }

    if (typeof this.move === 'function') {
      this.move(dt);
    }
    if (typeof this.sense === 'function') {
      this.sense(dt, ants);
    }
  }

  move(dt) {
    this.pos.x += (this.vel.x || 0) * dt;
    this.pos.y += (this.vel.y || 0) * dt;
  }

  sense() {
    // Placeholder for sensing logic in specialized ants.
  }

  cleanerSense(ants) {
    if (this.isDead || this.type !== 'cleaner') return null;
    if (!Array.isArray(ants)) return null;

    const sightRadius =
      typeof WASTE !== 'undefined' && WASTE && typeof WASTE.cleanerSightRadius === 'number'
        ? WASTE.cleanerSightRadius
        : 0;

    let closestCorpse = null;
    let closestDistance = Infinity;

    for (const ant of ants) {
      if (ant === this || ant.type !== 'corpse') continue;
      const dx = ant.pos.x - this.pos.x;
      const dy = ant.pos.y - this.pos.y;
      const dist = Math.hypot(dx, dy);
      if (dist <= sightRadius && dist < closestDistance) {
        closestCorpse = ant;
        closestDistance = dist;
      }
    }

    this.targetCorpse = closestCorpse;
    return closestCorpse;
  }

  interact(ants, addWaste, dt = 1) {
    if (this.isDead || this.type !== 'cleaner') return;

    const corpse = this.targetCorpse || this.cleanerSense(ants);
    if (!this.carryingCorpse && corpse) {
      this.moveTowards(corpse.pos, dt);
      const dx = corpse.pos.x - this.pos.x;
      const dy = corpse.pos.y - this.pos.y;
      if (Math.hypot(dx, dy) < CONSTANTS.CELL_SIZE / 2) {
        const index = ants.indexOf(corpse);
        if (index !== -1) {
          ants.splice(index, 1);
        }
        this.carryingCorpse = true;
        this.targetCorpse = null;
      }
    }

    if (this.carryingCorpse) {
      const wasteTarget = this.getWasteTarget();
      if (wasteTarget) {
        this.moveTowards(wasteTarget, dt);
      }

      if (this.isInWasteArea()) {
        if (typeof addWaste === 'function') {
          const wasteAmount =
            (typeof WASTE !== 'undefined' && WASTE && WASTE.corpseWasteAmount) || 100;
          addWaste(this.pos.x, this.pos.y, wasteAmount);
        }
        this.carryingCorpse = false;
      }
    }
  }

  moveTowards(target, dt = 1) {
    if (!target) return;
    const dx = target.x - this.pos.x;
    const dy = target.y - this.pos.y;
    const dist = Math.hypot(dx, dy) || 1;
    const speed = this.speed || CONSTANTS.CELL_SIZE;
    this.pos.x += (dx / dist) * speed * dt;
    this.pos.y += (dy / dist) * speed * dt;
  }

  isInWasteArea() {
    if (typeof WASTE === 'undefined' || !WASTE) return false;
    if (typeof WASTE.isWasteTile === 'function') {
      return Boolean(WASTE.isWasteTile(this.pos.x, this.pos.y));
    }
    if (Array.isArray(WASTE.tiles)) {
      return WASTE.tiles.some((tile) =>
        Math.hypot((tile?.x || 0) - this.pos.x, (tile?.y || 0) - this.pos.y) <=
        (tile?.radius || CONSTANTS.CELL_SIZE)
      );
    }
    const dropoff = WASTE.dropoff || WASTE.pos || WASTE.target;
    if (dropoff && typeof dropoff.x === 'number' && typeof dropoff.y === 'number') {
      const radius = dropoff.radius || WASTE.cleanerSightRadius || CONSTANTS.CELL_SIZE;
      return Math.hypot(dropoff.x - this.pos.x, dropoff.y - this.pos.y) <= radius;
    }
    return false;
  }

  getWasteTarget() {
    if (typeof WASTE === 'undefined' || !WASTE) return null;
    if (WASTE.dropoff) return WASTE.dropoff;
    if (Array.isArray(WASTE.tiles) && WASTE.tiles.length) return WASTE.tiles[0];
    if (WASTE.pos) return WASTE.pos;
    if (WASTE.target) return WASTE.target;
    return null;
  }

  render(ctx) {
    if (!ctx) return;

    // Ant body
    ctx.fillStyle = 'black';
    ctx.beginPath();
    ctx.arc(this.pos.x, this.pos.y, 3, 0, Math.PI * 2);
    ctx.fill();

    // Sharing visualization
    if (this.shareTargets.length) {
      ctx.strokeStyle = 'yellow';
      ctx.lineWidth = 1;
      for (const other of this.shareTargets) {
        ctx.beginPath();
        ctx.moveTo(this.pos.x, this.pos.y);
        ctx.lineTo(other.pos.x, other.pos.y);
        ctx.stroke();
      }
      this.shareTargets.length = 0;
    }
  }
}

export { Ant, CONSTANTS };
