use std::{hint::black_box, time::Duration};

use criterion::{criterion_group, criterion_main, Criterion};
use vowel_count::count_ascii_vowels;

fn bench_vowels(criterion: &mut Criterion) {
    let phrase = "Résumé: a useful Rust workload counts ASCII vowels in UTF-8. 🦀\n";
    let workloads = [
        ("small", String::from("a Café 🦀 A")),
        ("typical", phrase.repeat(256)),
        ("large", phrase.repeat(8192)),
    ];
    for (label, text) in workloads {
        criterion.bench_function(label, |bench| {
            bench.iter(|| count_ascii_vowels(black_box(text.as_str())));
        });
    }
}

criterion_group! {
    name = benches;
    config = Criterion::default()
        .sample_size(50)
        .warm_up_time(Duration::from_secs(1))
        .measurement_time(Duration::from_secs(2));
    targets = bench_vowels
}
criterion_main!(benches);
