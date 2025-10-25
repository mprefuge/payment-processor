const { createLogger } = require('../../lib/logger');
/**
 * Metrics Service
 *
 * Collects and reports metrics for contact matching and transaction processing
 * Provides observability into auto-link vs review rates and performance
 */

class MetricsService {
  constructor() {
    this.metrics = {
      totalTransactions: 0,
      autoLinked: 0,
      reviewRequired: 0,
      noMatchesFound: 0,
      decisionsBreakdown: {
        associate: 0,
        review: 0,
      },
      reasonsBreakdown: {
        high_confidence_match: 0,
        uncertain_match: 0,
        low_confidence_match: 0,
        no_viable_candidates: 0,
      },
      confidenceBreakdown: {
        high: 0,
        medium: 0,
        low: 0,
        none: 0,
      },
      scoreDistribution: {
        ranges: {
          '0.9-1.0': 0,
          '0.8-0.89': 0,
          '0.7-0.79': 0,
          '0.6-0.69': 0,
          '0.5-0.59': 0,
          '0.0-0.49': 0,
        },
        total: 0,
        sum: 0,
      },
      processingTimes: [],
      errors: 0,
      cacheHits: 0,
    };
    this.logger = createLogger({ scope: 'MetricsService' });
  }

  /**
   * Record a contact matching decision
   * @param {Object} decision - Decision object from ContactMatcher
   * @param {number} processingTimeMs - Processing time in milliseconds
   * @param {boolean} fromCache - Whether result was from cache
   */
  recordDecision(decision, processingTimeMs = 0, fromCache = false) {
    this.metrics.totalTransactions++;

    if (fromCache) {
      this.metrics.cacheHits++;
    }

    // Record decision action
    if (decision.action === 'associate') {
      this.metrics.autoLinked++;
      this.metrics.decisionsBreakdown.associate++;
    } else if (decision.action === 'review') {
      this.metrics.reviewRequired++;
      this.metrics.decisionsBreakdown.review++;
    }

    // Record reason
    if (decision.reason && this.metrics.reasonsBreakdown.hasOwnProperty(decision.reason)) {
      this.metrics.reasonsBreakdown[decision.reason]++;
    }

    // Record confidence level
    if (
      decision.confidence &&
      this.metrics.confidenceBreakdown.hasOwnProperty(decision.confidence)
    ) {
      this.metrics.confidenceBreakdown[decision.confidence]++;
    }

    // Record score distribution
    if (typeof decision.bestScore === 'number') {
      this.recordScore(decision.bestScore);
    }

    // Record processing time
    if (processingTimeMs > 0) {
      this.metrics.processingTimes.push(processingTimeMs);

      // Keep only last 100 processing times
      if (this.metrics.processingTimes.length > 100) {
        this.metrics.processingTimes.shift();
      }
    }

    // Track special cases
    if (decision.reason === 'no_viable_candidates') {
      this.metrics.noMatchesFound++;
    }

    this.logger.info('MetricsService: Recorded decision', {
      action: decision.action,
      reason: decision.reason,
      confidence: decision.confidence,
      score: decision.bestScore,
      processingTimeMs,
      fromCache,
    });
  }

  /**
   * Record a score in the distribution
   * @param {number} score - Score to record
   */
  recordScore(score) {
    this.metrics.scoreDistribution.total++;
    this.metrics.scoreDistribution.sum += score;

    // Categorize into ranges
    if (score >= 0.9) {
      this.metrics.scoreDistribution.ranges['0.9-1.0']++;
    } else if (score >= 0.8) {
      this.metrics.scoreDistribution.ranges['0.8-0.89']++;
    } else if (score >= 0.7) {
      this.metrics.scoreDistribution.ranges['0.7-0.79']++;
    } else if (score >= 0.6) {
      this.metrics.scoreDistribution.ranges['0.6-0.69']++;
    } else if (score >= 0.5) {
      this.metrics.scoreDistribution.ranges['0.5-0.59']++;
    } else {
      this.metrics.scoreDistribution.ranges['0.0-0.49']++;
    }
  }

  /**
   * Record an error
   * @param {string} errorType - Type of error
   * @param {string} message - Error message
   */
  recordError(errorType, message) {
    this.metrics.errors++;

    this.logger.error('MetricsService: Recorded error', {
      errorType,
      message,
      totalErrors: this.metrics.errors,
    });
  }

  /**
   * Get current metrics snapshot
   * @returns {Object} Current metrics
   */
  getMetrics() {
    const metrics = { ...this.metrics };

    // Calculate derived metrics
    metrics.rates = this.calculateRates();
    metrics.averages = this.calculateAverages();
    metrics.performance = this.calculatePerformance();

    return metrics;
  }

  /**
   * Calculate rate-based metrics
   */
  calculateRates() {
    const total = this.metrics.totalTransactions || 1; // Avoid division by zero

    return {
      autoLinkRate: this.metrics.autoLinked / total,
      reviewRate: this.metrics.reviewRequired / total,
      noMatchRate: this.metrics.noMatchesFound / total,
      cacheHitRate: this.metrics.cacheHits / total,
      errorRate: this.metrics.errors / total,
    };
  }

  /**
   * Calculate average metrics
   */
  calculateAverages() {
    const averages = {};

    // Average score
    if (this.metrics.scoreDistribution.total > 0) {
      averages.score = this.metrics.scoreDistribution.sum / this.metrics.scoreDistribution.total;
    } else {
      averages.score = 0;
    }

    // Average processing time
    if (this.metrics.processingTimes.length > 0) {
      averages.processingTimeMs =
        this.metrics.processingTimes.reduce((sum, time) => sum + time, 0) /
        this.metrics.processingTimes.length;
    } else {
      averages.processingTimeMs = 0;
    }

    return averages;
  }

  /**
   * Calculate performance metrics
   */
  calculatePerformance() {
    const performance = {};

    // Processing time percentiles
    if (this.metrics.processingTimes.length > 0) {
      const sorted = [...this.metrics.processingTimes].sort((a, b) => a - b);
      const len = sorted.length;

      performance.processingTime = {
        min: sorted[0],
        max: sorted[len - 1],
        median:
          len % 2 === 0 ? (sorted[len / 2 - 1] + sorted[len / 2]) / 2 : sorted[Math.floor(len / 2)],
        p95: sorted[Math.floor(len * 0.95)],
        p99: sorted[Math.floor(len * 0.99)],
      };
    }

    return performance;
  }

  /**
   * Generate a summary report
   * @returns {string} Human-readable summary
   */
  generateSummaryReport() {
    const metrics = this.getMetrics();
    const rates = metrics.rates;
    const averages = metrics.averages;

    let report = '📊 Contact Matching Metrics Summary\n';
    report += '=====================================\n\n';

    report += `Total Transactions Processed: ${metrics.totalTransactions}\n`;
    report += `Auto-linked: ${metrics.autoLinked} (${(rates.autoLinkRate * 100).toFixed(1)}%)\n`;
    report += `Review Required: ${metrics.reviewRequired} (${(rates.reviewRate * 100).toFixed(1)}%)\n`;
    report += `No Matches Found: ${metrics.noMatchesFound} (${(rates.noMatchRate * 100).toFixed(1)}%)\n`;
    report += `Cache Hits: ${metrics.cacheHits} (${(rates.cacheHitRate * 100).toFixed(1)}%)\n`;
    report += `Errors: ${metrics.errors} (${(rates.errorRate * 100).toFixed(1)}%)\n\n`;

    report += 'Decision Breakdown:\n';
    Object.entries(metrics.reasonsBreakdown).forEach(([reason, count]) => {
      if (count > 0) {
        const percentage = ((count / metrics.totalTransactions) * 100).toFixed(1);
        report += `  ${reason.replace(/_/g, ' ')}: ${count} (${percentage}%)\n`;
      }
    });

    report += '\nScore Distribution:\n';
    Object.entries(metrics.scoreDistribution.ranges).forEach(([range, count]) => {
      if (count > 0) {
        const percentage = ((count / metrics.scoreDistribution.total) * 100).toFixed(1);
        report += `  ${range}: ${count} (${percentage}%)\n`;
      }
    });

    report += `\nAverage Score: ${averages.score.toFixed(3)}\n`;
    report += `Average Processing Time: ${averages.processingTimeMs.toFixed(0)}ms\n`;

    return report;
  }

  /**
   * Reset all metrics (for testing/new periods)
   */
  reset() {
    this.metrics = {
      totalTransactions: 0,
      autoLinked: 0,
      reviewRequired: 0,
      noMatchesFound: 0,
      decisionsBreakdown: {
        associate: 0,
        review: 0,
      },
      reasonsBreakdown: {
        high_confidence_match: 0,
        uncertain_match: 0,
        low_confidence_match: 0,
        no_viable_candidates: 0,
      },
      confidenceBreakdown: {
        high: 0,
        medium: 0,
        low: 0,
        none: 0,
      },
      scoreDistribution: {
        ranges: {
          '0.9-1.0': 0,
          '0.8-0.89': 0,
          '0.7-0.79': 0,
          '0.6-0.69': 0,
          '0.5-0.59': 0,
          '0.0-0.49': 0,
        },
        total: 0,
        sum: 0,
      },
      processingTimes: [],
      errors: 0,
      cacheHits: 0,
    };

    this.logger.info('MetricsService: Reset all metrics');
  }
}

module.exports = MetricsService;
