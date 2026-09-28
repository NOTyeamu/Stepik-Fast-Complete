using System;

class Program
{
    static void Main()
    {
        for (int i = 1; i <= 9; i++)
        {
            if (i == 5)
            {
                continue;
            }

            for (int j = 1; j <= 9; j++)
            {
                if (j == 5)
                {
                    continue;
                }

                Console.WriteLine(i + " * " + j + " = " + (i * j));
            }
        }
    }
}