//! Segment table with IDM-style dynamic segmentation: when a connection runs out
//! of work it takes over the second half of the largest range still in flight.

use serde::{Deserialize, Serialize};

/// Byte range `[start, end)` of which `[start, pos)` is on disk.
/// `end == u64::MAX` means the length is unknown (stream until EOF).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Segment {
    pub start: u64,
    pub end: u64,
    pub pos: u64,
}

impl Segment {
    pub fn remaining(&self) -> u64 {
        self.end.saturating_sub(self.pos)
    }
    pub fn done(&self) -> bool {
        self.pos >= self.end
    }
}

#[derive(Debug)]
struct Slot {
    seg: Segment,
    busy: bool,
}

#[derive(Debug)]
pub struct SegmentTable {
    slots: Vec<Slot>,
    min_split: u64,
    splits: usize,
}

/// Largest write a worker performs between two table checks. Splits never cut
/// closer than `min_split` ahead of `pos`, so a write of this size can't cross
/// into a range handed to another connection.
pub const MAX_WRITE: usize = 64 * 1024;

impl SegmentTable {
    pub fn new(size: Option<u64>, parts: usize, min_split: u64) -> Self {
        let min_split = min_split.max(MAX_WRITE as u64);
        let slots = match size {
            Some(size) if parts > 1 && size >= min_split * 2 => {
                let parts = (parts as u64).min(size / min_split).max(1);
                let step = size / parts;
                (0..parts)
                    .map(|i| {
                        let start = i * step;
                        let end = if i == parts - 1 { size } else { start + step };
                        Slot { seg: Segment { start, end, pos: start }, busy: false }
                    })
                    .collect()
            }
            Some(size) => vec![Slot { seg: Segment { start: 0, end: size, pos: 0 }, busy: false }],
            None => vec![Slot { seg: Segment { start: 0, end: u64::MAX, pos: 0 }, busy: false }],
        };
        Self { slots, min_split, splits: 0 }
    }

    pub fn from_saved(segments: &[Segment], min_split: u64) -> Self {
        let slots = segments.iter().map(|&seg| Slot { seg, busy: false }).collect();
        Self { slots, min_split: min_split.max(MAX_WRITE as u64), splits: 0 }
    }

    /// Picks work for an idle connection: an unfinished idle range first,
    /// otherwise splits the busy range with the most bytes left.
    pub fn claim(&mut self) -> Option<usize> {
        if let Some(i) = self.slots.iter().position(|s| !s.busy && !s.seg.done()) {
            self.slots[i].busy = true;
            return Some(i);
        }
        let (i, rem) = self
            .slots
            .iter()
            .enumerate()
            .filter(|(_, s)| s.busy && s.seg.end != u64::MAX)
            .map(|(i, s)| (i, s.seg.remaining()))
            .max_by_key(|&(_, r)| r)?;
        if rem < self.min_split * 2 {
            return None;
        }
        let old = &mut self.slots[i].seg;
        let mid = old.pos + rem / 2;
        let new = Segment { start: mid, end: old.end, pos: mid };
        old.end = mid;
        self.slots.push(Slot { seg: new, busy: true });
        self.splits += 1;
        Some(self.slots.len() - 1)
    }

    pub fn release(&mut self, i: usize) {
        self.slots[i].busy = false;
    }

    pub fn get(&self, i: usize) -> Segment {
        self.slots[i].seg
    }

    /// How many of `want` bytes at the slot's current position still belong to it.
    pub fn allowed(&self, i: usize, want: usize) -> usize {
        self.slots[i].seg.remaining().min(want as u64) as usize
    }

    pub fn commit(&mut self, i: usize, n: u64) {
        self.slots[i].seg.pos += n;
    }

    /// Throws away a range's progress (servers without range support).
    pub fn rewind(&mut self, i: usize) {
        let s = &mut self.slots[i].seg;
        s.pos = s.start;
    }

    /// Marks an unknown-length range as finished at its current position.
    pub fn close_at_eof(&mut self, i: usize) {
        let s = &mut self.slots[i].seg;
        s.end = s.pos;
    }

    pub fn downloaded(&self) -> u64 {
        self.slots.iter().map(|s| s.seg.pos - s.seg.start).sum()
    }

    pub fn is_complete(&self) -> bool {
        self.slots.iter().all(|s| s.seg.done())
    }

    pub fn busy_count(&self) -> usize {
        self.slots.iter().filter(|s| s.busy).count()
    }

    pub fn splits(&self) -> usize {
        self.splits
    }

    pub fn snapshot(&self) -> Vec<Segment> {
        let mut v: Vec<Segment> = self.slots.iter().map(|s| s.seg).collect();
        v.sort_by_key(|s| s.start);
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MB: u64 = 1024 * 1024;

    fn covers_exactly(t: &SegmentTable, size: u64) {
        let snap = t.snapshot();
        assert_eq!(snap.first().unwrap().start, 0);
        assert_eq!(snap.last().unwrap().end, size);
        for w in snap.windows(2) {
            assert_eq!(w[0].end, w[1].start, "ranges must be contiguous");
        }
    }

    #[test]
    fn initial_split_covers_file() {
        let t = SegmentTable::new(Some(10 * MB + 7), 8, 256 * 1024);
        assert_eq!(t.snapshot().len(), 8);
        covers_exactly(&t, 10 * MB + 7);
    }

    #[test]
    fn small_file_gets_fewer_parts() {
        let t = SegmentTable::new(Some(300 * 1024), 8, 256 * 1024);
        assert_eq!(t.snapshot().len(), 1);
    }

    #[test]
    fn idle_worker_splits_largest_busy_range() {
        let size = 8 * MB;
        let mut t = SegmentTable::new(Some(size), 2, 256 * 1024);
        let a = t.claim().unwrap();
        let b = t.claim().unwrap();
        // b finishes, a has progressed a little
        t.commit(a, MB);
        let bseg = t.get(b);
        t.commit(b, bseg.remaining());
        t.release(b);
        let c = t.claim().expect("should split a");
        let aseg = t.get(a);
        let cseg = t.get(c);
        assert_eq!(aseg.end, cseg.start);
        assert!(cseg.start >= aseg.pos + 256 * 1024);
        assert_eq!(t.splits(), 1);
        covers_exactly(&t, size);
    }

    #[test]
    fn no_split_below_threshold() {
        let mut t = SegmentTable::new(Some(400 * 1024), 1, 256 * 1024);
        let _a = t.claim().unwrap();
        assert!(t.claim().is_none());
    }
}
