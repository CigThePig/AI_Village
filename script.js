const CONSTANTS = {
  CELL_SIZE: 16,
};

class Ant {
  constructor(x, y) {
    this.pos = { x, y };
    this.vel = { x: 0, y: 0 };
    this.hasFood = false;
    this.returnDir = null;
    this.shareTargets = [];
    this.energy = 100;
    this.maxEnergy = 100;
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
    // Metabolism
    this.energy = Math.max(0, this.energy - 2.5 * dt);

    // Self-feeding when hungry
    if (this.hasFood && this.energy < 30) {
      this.hasFood = false;
      this.energy = this.maxEnergy;
      this.returnDir = null;
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
