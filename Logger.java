import java.util.*;
import java.io.PrintStream;


public class Logger {
	Appender appender = null;
	public Logger(Appender a) {
		appender = a;
	}

	public void log(Date time, String message, String severity) {
		appender.append(time.toString() + " " + severity + " " + message);
	}

	public static void main(String[] args) {
		Logger logger = new Logger(new PrintStreamAppender(System.out));
		logger.log(new Date(), "test message", "test severity");
	}
} 