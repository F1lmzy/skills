use vowel_count::count_ascii_vowels;

#[test]
fn preserves_ascii_only_semantics() {
    for (input, expected) in [
        ("", 0),
        ("AEIOUaeiou", 10),
        ("123!?xyz", 0),
        ("café naïve 🦀 ÁÉİ œuvre", 5),
        ("A\0e\nU", 3),
    ] {
        assert_eq!(count_ascii_vowels(input), expected, "input: {input:?}");
    }
}

#[test]
fn matches_reference_across_unicode() {
    let mut input: String = (0..=0x10ffff).filter_map(char::from_u32).collect();
    input.push_str("aEiOu".repeat(1024).as_str());
    let expected = input
        .chars()
        .filter(|&ch| "aeiouAEIOU".contains(ch))
        .count();
    assert_eq!(count_ascii_vowels(&input), expected);
}
