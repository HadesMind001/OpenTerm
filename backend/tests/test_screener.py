from __future__ import annotations

import pytest

from openterm.services.screener import correlation_matrix, pearson


def test_pearson_perfect_positive():
    assert pearson([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]) == pytest.approx(1.0)


def test_pearson_perfect_negative():
    assert pearson([1, 2, 3, 4, 5], [10, 8, 6, 4, 2]) == pytest.approx(-1.0)


def test_pearson_constant_series_safe():
    assert pearson([1, 1, 1], [1, 2, 3]) == 0.0


def test_correlation_matrix_shape_and_symmetry():
    keys, mat = correlation_matrix({
        "A": [0.01, 0.02, -0.01, 0.03, 0.01],
        "B": [0.02, 0.04, -0.02, 0.06, 0.02],
        "C": [-0.01, 0.00, 0.02, -0.03, 0.05],
    })
    assert keys == ["A", "B", "C"]
    n = len(mat)
    assert all(len(row) == n for row in mat)
    for i in range(n):
        assert mat[i][i] == 1.0
        for j in range(n):
            assert mat[i][j] == mat[j][i]
    assert mat[0][1] > 0.9
    assert mat[0][2] < 0.9


def test_correlation_skips_short_series():
    keys, _ = correlation_matrix({
        "A": [0.01, 0.02],
        "B": [0.03],
    })
    assert keys == ["A"]


def test_correlation_empty():
    assert correlation_matrix({}) == ([], [])
