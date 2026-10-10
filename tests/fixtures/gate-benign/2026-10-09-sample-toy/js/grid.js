export class Grid {
  constructor(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.cells = new Uint8Array(cols * rows);
  }
  get(x, y) { return this.cells[y * this.cols + x]; }
  set(x, y, v) { this.cells[y * this.cols + x] = v; }
  clear() { this.cells.fill(0); }
  seedCenter() { this.set(this.cols >> 1, this.rows - 1, 1); }
  lastRow() { return this.cells.slice((this.rows - 1) * this.cols); }
  scroll(row) {
    this.cells.copyWithin(0, this.cols);
    this.cells.set(row, (this.rows - 1) * this.cols);
  }
}
