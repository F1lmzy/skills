pub fn count_ascii_vowels(text: &str) -> usize {
    text.chars()
        .filter(|&ch| matches!(ch.to_ascii_lowercase(), 'a' | 'e' | 'i' | 'o' | 'u'))
        .count()
}
