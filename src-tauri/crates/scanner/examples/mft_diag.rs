//! MFT 档记账诊断（MS6 对账 802GB 超额排查用，管理员手跑）。
//!
//! 跳过建树，直接顺序流 + 解析层统计各类 alloc 分桶，回答"多出来的 415GB 在哪一格"：
//! · Σdata_alloc（基记录无名 $DATA）  —— 应 ≈ walk 的 bytes_alloc
//! · Σads_alloc（带名 $DATA）        —— 应是小头
//! · 扩展记录（base_ref≠0）的 Σdata_alloc
//! · data_alloc top10 逐条对照（偏大/重复一目了然）
//! · 记录号重复检测（流层双产出）
//!
//! 用法（管理员）：
//!   cargo run --release -p deepclean-scanner --example mft_diag -- D

use deepclean_scanner::mft::{
    apply_update_sequence, parse_boot_sector, parse_record, MftStream, RawVolume, VolumeRead,
};
use std::collections::HashSet;

struct Acc {
    seen: HashSet<u64>,
    dup: usize,
    base_count: u64,
    base_data_alloc: u64,
    base_data_size: u64,
    base_resident: u64,
    ads_count: u64,
    ads_alloc: u64,
    ext_count: u64,
    ext_data_alloc: u64,
    deleted: u64,
    free: u64,
    corrupt: u64,
    ads_top: Vec<(u64, u64, String)>, // alloc, number, 主名 —— ADS 明细（诊断 415GB）
    top: Vec<(u64, String, u64, u64, u64, u64)>, // alloc,name,number,data_size,ads_count,ads_alloc
    attr_list_records: u64,
}

fn main() {
    let arg = std::env::args().nth(1).unwrap_or_else(|| "D".to_string());
    let drive = arg.chars().find(|c| c.is_ascii_alphabetic()).unwrap_or('D');

    let mut vol = match RawVolume::open(drive) {
        Ok(v) => v,
        Err(e) => {
            eprintln!(r"打开 \\.\{drive}: 失败（win32 {e}）—— 要管理员权限。");
            std::process::exit(1);
        }
    };
    let mut sector = [0u8; 512];
    vol.read_exact_at(0, &mut sector).expect("读引导扇区");
    let geo = parse_boot_sector(&sector).expect("引导扇区");
    let mut st = MftStream::open(vol, &geo).expect("开流");
    eprintln!(
        "几何: 簇={}B 记录={}B total_records={}",
        geo.cluster_bytes(),
        geo.bytes_per_file_record,
        st.total_records()
    );

    let record_bytes = st.record_size() as usize;
    let mut buf = vec![0u8; record_bytes];
    let mut a = Acc {
        seen: HashSet::new(),
        dup: 0,
        base_count: 0,
        base_data_alloc: 0,
        base_data_size: 0,
        base_resident: 0,
        ads_count: 0,
        ads_alloc: 0,
        ext_count: 0,
        ext_data_alloc: 0,
        deleted: 0,
        free: 0,
        corrupt: 0,
        ads_top: Vec::new(),
        top: Vec::new(),
        attr_list_records: 0,
    };

    while let Ok(Some(n)) = st.next_raw(&mut buf) {
        if !a.seen.insert(n) {
            a.dup += 1;
        }
        if !looks_like(&buf) {
            a.free += 1;
            continue;
        }
        if !apply_update_sequence(&mut buf, geo.bytes_per_sector) {
            a.corrupt += 1;
            continue;
        }
        let Some(rec) = parse_record(&buf, n) else {
            a.corrupt += 1;
            continue;
        };
        if !rec.in_use {
            a.deleted += 1;
            continue;
        }
        let da = rec.data_alloc.unwrap_or(0);
        let ds = rec.data_size.unwrap_or(0);
        if rec.base_ref != 0 {
            a.ext_count += 1;
            a.ext_data_alloc += da;
            continue;
        }
        a.base_count += 1;
        a.base_data_alloc += da;
        a.base_data_size += ds;
        if rec.data_alloc.is_none() {
            a.base_resident += 1;
        }
        if !rec.attr_list.is_empty() {
            a.attr_list_records += 1;
        }
        a.ads_count += rec.ads_count;
        a.ads_alloc += rec.ads_alloc;
        let name = rec
            .names
            .first()
            .map(|x| x.name.clone())
            .unwrap_or_else(|| format!("$rec{n}"));
        if rec.ads_alloc > 0 {
            a.ads_top.push((rec.ads_alloc, n, name.clone()));
        }
        if da > 0 {
            a.top.push((da, name, n, ds, rec.ads_count, rec.ads_alloc));
        }
    }

    a.top.sort_by(|x, y| y.0.cmp(&x.0));
    eprintln!("[重复] 记录号重复 = {}", a.dup);
    eprintln!("[记录] 在用基={} 扩展={} 已删={} 空闲/垃圾={} 损坏={}", a.base_count, a.ext_count, a.deleted, a.free, a.corrupt);
    eprintln!(
        "[基] Σdata_alloc={} Σdata_size={} Σads_alloc={} 驻留条数={}",
        a.base_data_alloc, a.base_data_size, a.ads_alloc, a.base_resident
    );
    eprintln!("[扩展] 条数={} Σdata_alloc={}", a.ext_count, a.ext_data_alloc);
    eprintln!(
        "[合计] data_alloc+ads_alloc = {} （对照哨兵 801929637888 / walk bytes_alloc 387804354336）",
        a.base_data_alloc + a.ads_alloc + a.ext_data_alloc
    );
    eprintln!("[ADS] 条数={} Σ={}", a.ads_count, a.ads_alloc);
    eprintln!("[attr_list] 携带 $ATTRIBUTE_LIST 的记录数 = {}", a.attr_list_records);
    a.ads_top.sort_by(|x, y| y.0.cmp(&x.0));
    let g1 = a.ads_top.iter().filter(|(x, _, _)| *x >= 1 << 30).count();
    eprintln!("[ADS明细] ≥1GB 条数={g1}；top15:");
    for (al, n, name) in a.ads_top.iter().take(15) {
        eprintln!("  ads_alloc={al:>14} #{n} {name}");
    }
    eprintln!("[top10 MFT 侧 data_alloc]");
    for (da, name, n, ds, ac, aa) in a.top.iter().take(10) {
        eprintln!("  alloc={da:>14} size={ds:>14} ads(n={ac},{aa}B) #{n} {name}");
    }
}

fn looks_like(buf: &[u8]) -> bool {
    buf.len() >= 4 && &buf[0..4] == b"FILE"
}
